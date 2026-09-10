param(
  [string]$TaskName = 'Nymrel Remote',
  [switch]$Uninstall,
  [switch]$NoStart,
  [hashtable]$Environment = @{}
)

$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $env:LOCALAPPDATA 'Nymrel\Remote'
$launcher = Join-Path $runtimeDir 'run.cmd'
$powerShellLauncher = Join-Path $runtimeDir 'run.ps1'
$logFile = Join-Path $runtimeDir 'supervisor.log'

function ConvertTo-PowerShellLiteral {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

if ($Uninstall) {
  & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $powerShellLauncher -Force -ErrorAction SilentlyContinue
  Write-Host "Removed '$TaskName'. Device credentials and logs were preserved in $runtimeDir."
  exit 0
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$supervisor = (Resolve-Path (Join-Path $PSScriptRoot 'nymrel-remote-supervisor.js')).Path
$workDir = Split-Path -Parent $PSScriptRoot

$serverUrl = [Environment]::GetEnvironmentVariable('NYMREL_REMOTE_SERVER_URL', 'User')
if (-not $serverUrl) {
  $serverUrl = [Environment]::GetEnvironmentVariable('NYMREL_REMOTE_SERVER_URL', 'Machine')
}
if (-not $serverUrl) {
  throw 'Persist NYMREL_REMOTE_SERVER_URL as a User or Machine environment variable before installing autostart.'
}

$allowedEnvironmentNames = @(
  'NYMREL_REMOTE_SERVER_URL',
  'NYMREL_REMOTE_DEVICE_NAME',
  'NYMREL_REMOTE_DEVICE_FILE',
  'NYMREL_REMOTE_ALLOWED_DIRECTORIES',
  'NYMREL_REMOTE_LOCAL_CWD',
  'NYMREL_REMOTE_LOCAL_SHELL',
  'NYMREL_REMOTE_BLOCKED_COMMANDS',
  'NYMREL_REMOTE_LOCAL_BACKEND'
)
$environmentLines = @()
foreach ($key in @($Environment.Keys | Sort-Object)) {
  $name = [string]$key
  if ($allowedEnvironmentNames -notcontains $name) {
    throw "Launcher environment variable is not allowlisted: $name"
  }
  $value = [string]$Environment[$key]
  if ($value -match "[\r\n]") {
    throw "Launcher environment variable contains a line break: $name"
  }
  $environmentLines += ('$env:{0} = {1}' -f $name, (ConvertTo-PowerShellLiteral $value))
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$powerShellBody = @(
  '$ErrorActionPreference = ''Stop'''
  $environmentLines
  ('Set-Location -LiteralPath {0}' -f (ConvertTo-PowerShellLiteral $workDir))
  ('& {0} {1} >> {2} 2>&1' -f (
    ConvertTo-PowerShellLiteral $node
  ), (
    ConvertTo-PowerShellLiteral $supervisor
  ), (
    ConvertTo-PowerShellLiteral $logFile
  ))
  'exit $LASTEXITCODE'
) -join "`r`n"
Set-Content -LiteralPath $powerShellLauncher -Value $powerShellBody -Encoding UTF8

$launcherBody = @"
@echo off
"$powerShell" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$powerShellLauncher"
"@
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding Ascii

& schtasks.exe /Create /SC ONLOGON /TN $TaskName /TR $launcher /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks.exe failed to create '$TaskName' (exit $LASTEXITCODE)." }

if (-not $NoStart) {
  & schtasks.exe /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks.exe created '$TaskName' but could not start it (exit $LASTEXITCODE)." }
  Write-Host "Installed and started '$TaskName'."
} else {
  Write-Host "Installed '$TaskName'; immediate startup was deferred."
}
Write-Host "Supervisor log: $logFile"
Write-Host 'If this is the first pairing, inspect the log for the short pairing code.'
