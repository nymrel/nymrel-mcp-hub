import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const bootstrapPath = new URL('../bin/bootstrap-nymrel-remote-windows.ps1', import.meta.url);
const installerPath = new URL('../bin/install-nymrel-remote-windows.ps1', import.meta.url);
const guidePath = new URL('../docs/WINDOWS_BOOTSTRAP.md', import.meta.url);

const [bootstrap, installer, guide] = await Promise.all([
  fs.readFile(bootstrapPath, 'utf8'),
  fs.readFile(installerPath, 'utf8'),
  fs.readFile(guidePath, 'utf8')
]);

const forbiddenServiceSecrets = [
  'NYMREL_REMOTE_SIGNING_KEY',
  'NYMREL_REMOTE_DATA_KEY',
  'NYMREL_REMOTE_AUDIT_KEY',
  'NYMREL_REMOTE_BOOTSTRAP_TOKEN',
  'NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_SECRET'
];

test('Windows bootstrap downloads an immutable source snapshot without pipe-to-execute', () => {
  assert.match(bootstrap, /api\.github\.com\/repos\/nymrel\/nymrel-mcp-hub\/commits/);
  assert.match(bootstrap, /archive\/\$commit\.zip/);
  assert.match(bootstrap, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(bootstrap, /NYMREL_REMOTE_PAIRING_CODE=/);
  assert.doesNotMatch(bootstrap, /\bInvoke-Expression\b|\biex\b/i);
  assert.doesNotMatch(guide, /\|\s*(?:iex|Invoke-Expression)\b/i);
});

test('Windows launchers pin only allowlisted nonsecret device configuration', () => {
  assert.match(installer, /\[hashtable\]\$Environment/);
  assert.match(installer, /Launcher environment variable is not allowlisted/);
  assert.match(installer, /run\.ps1/);
  assert.match(installer, /New-ScheduledTaskPrincipal/);
  assert.match(installer, /-LogonType Interactive/);
  assert.match(installer, /-RunLevel Limited/);
  assert.match(installer, /RestartCount 99/);
  assert.doesNotMatch(installer, /schtasks\.exe \/Create/);
  assert.match(bootstrap, /NYMREL_REMOTE_LOCAL_BACKEND' 'native'/);
  for (const name of forbiddenServiceSecrets) {
    assert.doesNotMatch(bootstrap, new RegExp(name));
    assert.doesNotMatch(installer, new RegExp(name));
  }
});

test('Windows bootstrap tolerates a first install with no existing scheduled task', () => {
  assert.match(bootstrap, /Get-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue/);
  assert.match(bootstrap, /if \(\$existingTask\)/);
  assert.match(bootstrap, /Stop-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(bootstrap, /schtasks\.exe \/End \/TN \$TaskName/);
});

test('Windows bootstrap preserves a single allowed directory as a JSON array', () => {
  assert.match(bootstrap, /ConvertTo-Json -InputObject @\(\$resolvedAllowed\) -Compress/);
  assert.doesNotMatch(bootstrap, /@\(\$resolvedAllowed\) \| ConvertTo-Json/);
});

test('Windows installer verifies the scheduled supervisor remains running', () => {
  assert.match(installer, /function Wait-ScheduledTaskRunning/);
  assert.match(installer, /Get-ScheduledTaskInfo -TaskPath/);
  assert.match(installer, /Wait-ScheduledTaskRunning -TaskName \$TaskName/);
  assert.ok(
    installer.indexOf("Start-ScheduledTask -TaskPath") < installer.indexOf('Wait-ScheduledTaskRunning -TaskName'),
    'task startup must precede the running-state verification'
  );
});

test('Windows launcher does not treat native supervisor stderr as a terminating PowerShell error', () => {
  const strictIndex = installer.indexOf("'$ErrorActionPreference = ''Stop'''");
  const locationIndex = installer.indexOf("'Set-Location -LiteralPath {0}'");
  const continueIndex = installer.indexOf("'$ErrorActionPreference = ''Continue'''");
  const supervisorIndex = installer.indexOf("'$process = [System.Diagnostics.Process]::Start($startInfo)'");
  assert.ok(strictIndex >= 0, 'launcher generation should fail fast during setup');
  assert.ok(locationIndex > strictIndex, 'working directory setup should run while errors are terminating');
  assert.ok(continueIndex > locationIndex, 'native stderr handling must change only after setup');
  assert.ok(supervisorIndex > continueIndex, 'supervisor must run after native stderr is made non-terminating');
});

test('Windows launcher hands the log file to the supervisor instead of redirecting through PowerShell', () => {
  const logEnvIndex = installer.indexOf("'$env:NYMREL_REMOTE_SUPERVISOR_LOG = {0}'");
  const supervisorIndex = installer.indexOf("'$process = [System.Diagnostics.Process]::Start($startInfo)'");
  assert.ok(logEnvIndex >= 0, 'launcher must pin the supervisor log path');
  assert.ok(supervisorIndex >= 0, 'launcher must start the supervisor through System.Diagnostics.Process');
  assert.ok(logEnvIndex < supervisorIndex, 'log path must be set before the supervisor starts');
  assert.doesNotMatch(installer, />> \{2\} 2>&1/, 'PowerShell redirection writes UTF-16LE without timestamps');
  assert.match(installer, /\$logFile = Join-Path \$runtimeDir 'supervisor\.log'/);
  assert.match(installer, /\$launcherStderr = Join-Path \$runtimeDir 'launcher-stderr\.log'/);
  assert.match(installer, /\$startInfo\.RedirectStandardError = \$true/);
  assert.match(installer, /\$startInfo\.UseShellExecute = \$false/);
  assert.match(installer, /New-Object System\.Text\.UTF8Encoding\(\$false\)/, 'startup stderr must be written as UTF-8 without BOM');
  assert.doesNotMatch(installer, /Start-Process/, 'Start-Process breaks under duplicate ComSpec/COMSPEC environment keys');
  assert.match(installer, /'exit \$process\.ExitCode'/);
  assert.match(guide, /supervisor\.log\.1/);
  assert.match(guide, /launcher-stderr\.log/);
  assert.match(guide, /UTF-8/);
});

test('Windows bootstrap waits for the running supervisor to stop before replacing the app directory', () => {
  assert.match(bootstrap, /\$stopDeadline = \[DateTime\]::UtcNow\.AddSeconds\(20\)/);
  assert.match(bootstrap, /while \(\$taskState -eq 'Running' -and \[DateTime\]::UtcNow -lt \$stopDeadline\)/);
  assert.match(bootstrap, /refusing to replace a running install/);
  assert.ok(
    bootstrap.indexOf('$stopDeadline') < bootstrap.indexOf('Copy-Item -LiteralPath $remoteSource -Destination $stagingDir'),
    'the stop wait must precede staging the replacement'
  );
});

test('Windows bootstrap preserves credentials outside replaceable application source', () => {
  assert.match(bootstrap, /Join-Path \$runtimeDir 'device\.json'/);
  assert.match(bootstrap, /app\.staging/);
  assert.match(bootstrap, /app\.previous/);
  assert.match(guide, /preserves `device\.json`/);
});
