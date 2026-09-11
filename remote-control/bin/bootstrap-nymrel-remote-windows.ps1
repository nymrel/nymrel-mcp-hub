[CmdletBinding()]
param(
  [string]$ServerUrl = 'https://nymrel-remote-production.up.railway.app',
  [string]$DeviceName = $env:COMPUTERNAME,
  [string[]]$AllowedDirectory = @($env:USERPROFILE),
  [string]$TaskName = 'Nymrel Remote',
  [string]$Ref = 'main'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Set-UserEnvironmentVariable {
  param([string]$Name, [string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  Set-Item -LiteralPath "Env:$Name" -Value $Value
}

$server = [Uri]$ServerUrl
if ($server.Scheme -ne 'https' -or $server.UserInfo -or $server.Query -or $server.Fragment -or $server.AbsolutePath -ne '/') {
  throw 'ServerUrl must be an HTTPS origin without credentials, path, query, or fragment.'
}
if (-not $DeviceName -or $DeviceName.Length -gt 128) {
  throw 'DeviceName must contain 1 to 128 characters.'
}
if (-not $AllowedDirectory -or $AllowedDirectory.Count -eq 0) {
  throw 'At least one allowed directory is required.'
}
$resolvedAllowed = @(
  foreach ($item in $AllowedDirectory) {
    if (-not (Test-Path -LiteralPath $item -PathType Container)) {
      throw "Allowed directory does not exist: $item"
    }
    (Resolve-Path -LiteralPath $item).Path
  }
)

$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersionText = (& $node --version).Trim().TrimStart('v').Split('-')[0]
$nodeVersion = [Version]$nodeVersionText
if ($nodeVersion.Major -lt 22) {
  throw "Nymrel Remote requires Node.js 22 or newer; found $nodeVersionText."
}

$runtimeDir = Join-Path $env:LOCALAPPDATA 'Nymrel\Remote'
$appDir = Join-Path $runtimeDir 'app'
$stagingDir = Join-Path $runtimeDir ("app.staging.{0}" -f [Guid]::NewGuid().ToString('N'))
$backupDir = Join-Path $runtimeDir 'app.previous'
$deviceFile = Join-Path $runtimeDir 'device.json'
$logFile = Join-Path $runtimeDir 'supervisor.log'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nymrel-remote-{0}" -f [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $tempRoot 'source.zip'
$extract = Join-Path $tempRoot 'source'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  $headers = @{ 'User-Agent' = 'Nymrel-Remote-Windows-Bootstrap' }
  $encodedRef = [Uri]::EscapeDataString($Ref)
  $commitInfo = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/nymrel/nymrel-mcp-hub/commits/$encodedRef"
  $commit = [string]$commitInfo.sha
  if ($commit -notmatch '^[0-9a-f]{40}$') {
    throw 'GitHub did not return a valid source commit.'
  }

  Write-Host "Downloading Nymrel Remote source at $commit..."
  Invoke-WebRequest -Headers $headers -Uri "https://github.com/nymrel/nymrel-mcp-hub/archive/$commit.zip" -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force

  $remoteSource = Get-ChildItem -LiteralPath $extract -Directory |
    ForEach-Object { Join-Path $_.FullName 'remote-control' } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\nymrel-remote-agent.js') } |
    Select-Object -First 1
  if (-not $remoteSource) {
    throw 'Downloaded archive does not contain the Nymrel Remote package.'
  }

  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  Copy-Item -LiteralPath $remoteSource -Destination $stagingDir -Recurse -Force
  if (Test-Path -LiteralPath $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
  }
  if (Test-Path -LiteralPath $appDir) {
    Move-Item -LiteralPath $appDir -Destination $backupDir
  }
  Move-Item -LiteralPath $stagingDir -Destination $appDir

  $allowedJson = ConvertTo-Json -InputObject @($resolvedAllowed) -Compress
  $origin = $server.GetLeftPart([UriPartial]::Authority)
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_SERVER_URL' $origin
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_DEVICE_NAME' $DeviceName
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_DEVICE_FILE' $deviceFile
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_ALLOWED_DIRECTORIES' $allowedJson
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_CWD' $resolvedAllowed[0]
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_SHELL' 'powershell.exe'
  Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_BACKEND' 'native'

  $agentEnvironment = @{
    NYMREL_REMOTE_SERVER_URL = $origin
    NYMREL_REMOTE_DEVICE_NAME = $DeviceName
    NYMREL_REMOTE_DEVICE_FILE = $deviceFile
    NYMREL_REMOTE_ALLOWED_DIRECTORIES = $allowedJson
    NYMREL_REMOTE_LOCAL_CWD = $resolvedAllowed[0]
    NYMREL_REMOTE_LOCAL_SHELL = 'powershell.exe'
    NYMREL_REMOTE_LOCAL_BACKEND = 'native'
  }
  $installer = Join-Path $appDir 'bin\install-nymrel-remote-windows.ps1'
  Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
  & $installer -TaskName $TaskName -Environment $agentEnvironment

  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $logFile)) {
      continue
    }
    $recent = (Get-Content -LiteralPath $logFile -Tail 200 -ErrorAction SilentlyContinue) -join "`n"
    $match = [regex]::Match($recent, 'Pair this device with code:\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{4})')
    if ($match.Success) {
      $pairingCode = $match.Groups[1].Value.ToUpperInvariant()
      Write-Host "Pair this JalenPC agent with code: $pairingCode"
      Write-Output "NYMREL_REMOTE_PAIRING_CODE=$pairingCode"
      exit 0
    }
    if ($recent -match 'Nymrel Remote agent online for') {
      Write-Host 'Nymrel Remote is installed, registered, and online.'
      Write-Output 'NYMREL_REMOTE_STATUS=ONLINE'
      exit 0
    }
  } while ((Get-Date) -lt $deadline)

  Write-Warning "Nymrel Remote was installed, but it did not report online or print a pairing code within 60 seconds. Inspect: $logFile"
  Write-Output "NYMREL_REMOTE_LOG=$logFile"
  exit 2
}
catch {
  if ((Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $appDir)) {
    Move-Item -LiteralPath $backupDir -Destination $appDir -ErrorAction SilentlyContinue
  }
  throw
}
finally {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
