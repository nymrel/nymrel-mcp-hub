[CmdletBinding()]
param(
  [string]$ServerUrl = 'https://nymrel-remote-production.up.railway.app',
  [string]$DeviceName = $env:COMPUTERNAME,
  [string[]]$AllowedDirectory = @($env:USERPROFILE),
  [string[]]$DeniedReadPath,
  [string]$TaskName = 'Nymrel Remote',
  [string]$InstanceName = 'Remote',
  [string]$Ref = 'main',
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Set-UserEnvironmentVariable {
  param([string]$Name, [string]$Value)
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  Set-Item -LiteralPath "Env:$Name" -Value $Value
}

function Resolve-DeniedReadPaths {
  param([AllowEmptyCollection()][string[]]$Paths)
  @(
    foreach ($item in $Paths) {
      $isOrdinaryAbsolute = $item -match '^[A-Za-z]:[\\/]' -or $item -match '^\\\\[^\\]+\\[^\\]+(?:\\|$)'
      if (-not $item -or -not $isOrdinaryAbsolute -or $item -match '^[\\/]{2}[?.][\\/]') {
        throw 'DeniedReadPath entries must be absolute, ordinary filesystem paths.'
      }
      [IO.Path]::GetFullPath($item)
    }
  )
}

$server = [Uri]$ServerUrl
if ($server.Scheme -ne 'https' -or $server.UserInfo -or $server.Query -or $server.Fragment -or $server.AbsolutePath -ne '/') {
  throw 'ServerUrl must be an HTTPS origin without credentials, path, query, or fragment.'
}
if (-not $DeviceName -or $DeviceName.Length -gt 128) {
  throw 'DeviceName must contain 1 to 128 characters.'
}
if ($InstanceName -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{0,31}$') {
  throw 'InstanceName must be 1 to 32 letters, digits, underscores, or hyphens, starting with a letter.'
}
if ($InstanceName -ne 'Remote' -and $TaskName -eq 'Nymrel Remote') {
  throw 'A separate instance requires a distinct TaskName.'
}
if ($InstanceName -ieq 'ChatGPTStudio' -and -not $PSBoundParameters.ContainsKey('AllowedDirectory')) {
  throw 'ChatGPTStudio requires an explicit -AllowedDirectory; the user-profile default is unsafe for a cloud client.'
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

$runtimeDir = Join-Path (Join-Path $env:LOCALAPPDATA 'Nymrel') $InstanceName
$deniedConfigFile = Join-Path $runtimeDir 'denied-read-paths.json'
foreach ($boundary in @((Join-Path $env:LOCALAPPDATA 'Nymrel'), $runtimeDir, $deniedConfigFile)) {
  if (Test-Path -LiteralPath $boundary) {
    $boundaryItem = Get-Item -LiteralPath $boundary -Force
    if ($boundaryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to install through a linked runtime path: $boundary"
    }
  }
}
# A separate instance must never inherit exclusions from the default Remote instance.
# Preserve each instance's saved list when an update omits -DeniedReadPath.
$deniedJson = if ($InstanceName -eq 'Remote') {
  [Environment]::GetEnvironmentVariable('NYMREL_REMOTE_DENIED_READ_PATHS', 'User')
} elseif (Test-Path -LiteralPath $deniedConfigFile -PathType Leaf) {
  Get-Content -LiteralPath $deniedConfigFile -Raw
} else {
  '[]'
}
if ($PSBoundParameters.ContainsKey('DeniedReadPath')) {
  $resolvedDenied = @(Resolve-DeniedReadPaths -Paths $DeniedReadPath)
  $deniedJson = ConvertTo-Json -InputObject @($resolvedDenied) -Compress
} elseif ($deniedJson) {
  try {
    $parsedDenied = ConvertFrom-Json -InputObject $deniedJson -ErrorAction Stop
  } catch {
    throw 'Existing NYMREL_REMOTE_DENIED_READ_PATHS must be a JSON string array.'
  }
  if (-not $deniedJson.TrimStart().StartsWith('[') -or @($parsedDenied | Where-Object { $_ -isnot [string] -or -not $_ }).Count -gt 0) {
    throw 'Existing NYMREL_REMOTE_DENIED_READ_PATHS must be a JSON string array.'
  }
  $resolvedDenied = if ($deniedJson.Trim() -eq '[]') {
    @()
  } else {
    @(Resolve-DeniedReadPaths -Paths @($parsedDenied))
  }
  # Set-Content appends CRLF; the launcher rejects line breaks. Serialize the
  # validated array again instead of forwarding raw saved file text.
  $deniedJson = ConvertTo-Json -InputObject @($resolvedDenied) -Compress
}
if ($deniedJson -match "[\r\n]") {
  throw 'Denied read paths could not be serialized as a single launcher value.'
}
if ($InstanceName -ieq 'ChatGPTStudio') {
  if (-not $env:USERPROFILE) {
    throw 'ChatGPTStudio cannot validate allowed roots without USERPROFILE.'
  }
  $profileRoot = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd([char[]]@('\', '/'))
  foreach ($root in $resolvedAllowed) {
    $component = Get-Item -LiteralPath $root -Force
    while ($component) {
      if ($component.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "ChatGPTStudio allowed directory cannot traverse a linked path: $root"
      }
      $component = $component.Parent
    }
    $allowedRoot = [IO.Path]::GetFullPath($root).TrimEnd([char[]]@('\', '/'))
    if ($profileRoot.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $profileRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "ChatGPTStudio allowed directory must be narrower than the user profile: $root"
    }
  }
}
if ($PreflightOnly) {
  Write-Output 'NYMREL_REMOTE_BOOTSTRAP_PREFLIGHT=OK'
  return
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersionText = (& $node --version).Trim().TrimStart('v').Split('-')[0]
$nodeVersion = [Version]$nodeVersionText
if ($nodeVersion.Major -lt 22) {
  throw "Nymrel Remote requires Node.js 22 or newer; found $nodeVersionText."
}

$appDir = Join-Path $runtimeDir 'app'
$stagingDir = Join-Path $runtimeDir ("app.staging.{0}" -f [Guid]::NewGuid().ToString('N'))
$backupDir = Join-Path $runtimeDir 'app.previous'
$deviceFile = Join-Path $runtimeDir 'device.json'
$logFile = Join-Path $runtimeDir 'supervisor.log'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("nymrel-remote-{0}" -f [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $tempRoot 'source.zip'
$extract = Join-Path $tempRoot 'source'

function Assert-InstancePath {
  param([string]$Path)
  $root = [IO.Path]::GetFullPath($runtimeDir).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside this instance: $target"
  }
  if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to modify a linked instance path: $target"
    }
  }
}

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
    # Wait until Task Scheduler reports the supervisor stopped before replacing the app directory;
    # a fixed sleep raced open file handles on slow hosts and made upgrades fail intermittently.
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 250
      $taskState = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    } while ($taskState -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
    if ($taskState -eq 'Running') {
      throw "Scheduled task '$TaskName' did not stop within 20 seconds; refusing to replace a running install."
    }
    Start-Sleep -Milliseconds 500
  }
  Copy-Item -LiteralPath $remoteSource -Destination $stagingDir -Recurse -Force
  Assert-InstancePath $backupDir
  Assert-InstancePath $appDir
  Assert-InstancePath $stagingDir
  if (Test-Path -LiteralPath $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
  }
  if (Test-Path -LiteralPath $appDir) {
    Move-Item -LiteralPath $appDir -Destination $backupDir
  }
  Move-Item -LiteralPath $stagingDir -Destination $appDir

  $allowedJson = ConvertTo-Json -InputObject @($resolvedAllowed) -Compress
  $origin = $server.GetLeftPart([UriPartial]::Authority)
  if ($InstanceName -eq 'Remote') {
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_SERVER_URL' $origin
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_DEVICE_NAME' $DeviceName
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_DEVICE_FILE' $deviceFile
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_ALLOWED_DIRECTORIES' $allowedJson
    if ($deniedJson) {
      Set-UserEnvironmentVariable 'NYMREL_REMOTE_DENIED_READ_PATHS' $deniedJson
    }
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_CWD' $resolvedAllowed[0]
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_SHELL' 'powershell.exe'
    Set-UserEnvironmentVariable 'NYMREL_REMOTE_LOCAL_BACKEND' 'native'
  }

  $agentEnvironment = @{
    NYMREL_REMOTE_SERVER_URL = $origin
    NYMREL_REMOTE_DEVICE_NAME = $DeviceName
    NYMREL_REMOTE_DEVICE_FILE = $deviceFile
    NYMREL_REMOTE_ALLOWED_DIRECTORIES = $allowedJson
    NYMREL_REMOTE_LOCAL_CWD = $resolvedAllowed[0]
    NYMREL_REMOTE_LOCAL_SHELL = 'powershell.exe'
    NYMREL_REMOTE_LOCAL_BACKEND = 'native'
  }
  if ($deniedJson) {
    $agentEnvironment.NYMREL_REMOTE_DENIED_READ_PATHS = $deniedJson
  }
  $installer = Join-Path $appDir 'bin\install-nymrel-remote-windows.ps1'
  Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
  & $installer -TaskName $TaskName -InstanceName $InstanceName -Environment $agentEnvironment
  if ($InstanceName -ne 'Remote' -and $deniedJson) {
    Set-Content -LiteralPath $deniedConfigFile -Value $deniedJson -Encoding UTF8
  }

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
  Assert-InstancePath $stagingDir
  Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  if (-not ([IO.Path]::GetFullPath($tempRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Refusing to remove a temp path outside the temp root.'
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
