param(
  [string]$TaskName = 'Nymrel Remote',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $env:LOCALAPPDATA 'Nymrel\Remote'
$launcher = Join-Path $runtimeDir 'run.cmd'
$logFile = Join-Path $runtimeDir 'supervisor.log'

if ($Uninstall) {
  & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  Write-Host "Removed '$TaskName'. Device credentials and logs were preserved in $runtimeDir."
  exit 0
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$supervisor = (Resolve-Path (Join-Path $PSScriptRoot 'nymrel-remote-supervisor.js')).Path
$workDir = Split-Path -Parent $PSScriptRoot

$serverUrl = [Environment]::GetEnvironmentVariable('NYMREL_REMOTE_SERVER_URL', 'User')
if (-not $serverUrl) {
  $serverUrl = [Environment]::GetEnvironmentVariable('NYMREL_REMOTE_SERVER_URL', 'Machine')
}
if (-not $serverUrl) {
  throw 'Persist NYMREL_REMOTE_SERVER_URL as a User or Machine environment variable before installing autostart.'
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$launcherBody = @"
@echo off
cd /d "$workDir"
"$node" "$supervisor" >> "$logFile" 2>&1
"@
Set-Content -LiteralPath $launcher -Value $launcherBody -Encoding Ascii

& schtasks.exe /Create /SC ONLOGON /TN $TaskName /TR $launcher /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks.exe failed to create '$TaskName' (exit $LASTEXITCODE)." }

& schtasks.exe /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks.exe created '$TaskName' but could not start it (exit $LASTEXITCODE)." }

Write-Host "Installed and started '$TaskName'."
Write-Host "Supervisor log: $logFile"
Write-Host 'If this is the first pairing, inspect the log for the short pairing code.'
