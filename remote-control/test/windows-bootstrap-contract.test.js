import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('Windows bootstrap carries explicit read exclusions and retains them across updates', () => {
  assert.match(installer, /'NYMREL_REMOTE_DENIED_READ_PATHS'/);
  assert.match(bootstrap, /\[string\[\]\]\$DeniedReadPath/);
  assert.match(bootstrap, /\$PSBoundParameters\.ContainsKey\('DeniedReadPath'\)/);
  assert.match(bootstrap, /GetEnvironmentVariable\('NYMREL_REMOTE_DENIED_READ_PATHS', 'User'\)/);
  assert.match(bootstrap, /ConvertTo-Json -InputObject @\(\$resolvedDenied\) -Compress/);
  assert.match(bootstrap, /\$agentEnvironment\.NYMREL_REMOTE_DENIED_READ_PATHS = \$deniedJson/);
  assert.match(bootstrap, /Set-UserEnvironmentVariable 'NYMREL_REMOTE_DENIED_READ_PATHS' \$deniedJson/);
  assert.match(bootstrap, /Set-Content appends CRLF; the launcher rejects line breaks/);
  assert.equal([...bootstrap.matchAll(/\$deniedJson = ConvertTo-Json -InputObject @\(\$resolvedDenied\) -Compress/g)].length, 2);
  assert.match(guide, /retains that instance's saved exclusions/);
});

test('ChatGPTStudio exclusion preflight accepts saved absolute paths and rejects unsafe entries', { skip: process.platform !== 'win32' }, async () => {
  const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-deny-preflight-'));
  const configDirectory = path.join(localAppData, 'Nymrel', 'ChatGPTStudio');
  const configFile = path.join(configDirectory, 'denied-read-paths.json');
  const root = path.dirname(fileURLToPath(bootstrapPath));
  const baseArgs = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(bootstrapPath),
    '-InstanceName', 'ChatGPTStudio', '-TaskName', 'Nymrel Remote ChatGPT Studio',
    '-AllowedDirectory', root, '-PreflightOnly'
  ];
  const run = (...args) => spawnSync('powershell.exe', [...baseArgs, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, LOCALAPPDATA: localAppData }
  });
  try {
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(configFile, `\uFEFF${JSON.stringify([path.join(root, 'private')])}\r\n`);
    assert.match(run().stdout, /NYMREL_REMOTE_BOOTSTRAP_PREFLIGHT=OK/);

    await fs.writeFile(configFile, JSON.stringify(['relative\\private']));
    const relativeSaved = run();
    assert.equal(relativeSaved.status, 1);
    assert.match(relativeSaved.stderr, /absolute, ordinary filesystem paths/);

    const relativeGiven = run('-DeniedReadPath', 'C:relative\\private');
    assert.equal(relativeGiven.status, 1);
    assert.match(relativeGiven.stderr, /absolute, ordinary filesystem paths/);

    await fs.writeFile(configFile, '[]');
    assert.match(run().stdout, /NYMREL_REMOTE_BOOTSTRAP_PREFLIGHT=OK/);
  } finally {
    await fs.rm(localAppData, { recursive: true, force: true });
  }
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
  assert.doesNotMatch(installer, /'\$process = Start-Process/, 'Start-Process breaks under duplicate ComSpec/COMSPEC environment keys');
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

test('a second Windows instance keeps its device file, task, and roots separate', () => {
  assert.match(bootstrap, /\[string\]\$InstanceName = 'Remote'/);
  assert.match(installer, /\[string\]\$InstanceName = 'Remote'/);
  assert.match(bootstrap, /Join-Path \(Join-Path \$env:LOCALAPPDATA 'Nymrel'\) \$InstanceName/);
  assert.match(installer, /Join-Path \(Join-Path \$env:LOCALAPPDATA 'Nymrel'\) \$InstanceName/);
  assert.match(bootstrap, /separate instance requires a distinct TaskName/);
  assert.match(installer, /separate instance requires an explicit launcher value/);
  assert.match(bootstrap, /if \(\$InstanceName -eq 'Remote'\) \{\s+Set-UserEnvironmentVariable/);
  assert.match(bootstrap, /\$installer -TaskName \$TaskName -InstanceName \$InstanceName -Environment \$agentEnvironment/);
  assert.match(guide, /Nymrel\\ChatGPTStudio/);
});

test('ChatGPTStudio bootstrap refuses implicit or whole-profile roots before download', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(bootstrapPath);
  const baseArgs = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-InstanceName', 'ChatGPTStudio', '-TaskName', 'Nymrel Remote ChatGPT Studio', '-PreflightOnly'
  ];
  for (const [label, args, expected] of [
    ['omitted root', [], /requires an explicit -AllowedDirectory/],
    ['user profile', ['-AllowedDirectory', os.homedir()], /must be narrower than the user profile/],
    ['profile ancestor', ['-AllowedDirectory', path.dirname(os.homedir())], /must be narrower than the user profile/]
  ]) {
    const result = spawnSync('powershell.exe', [...baseArgs, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, `${label}: ${result.error?.message ?? result.stderr}`);
    assert.match(result.stderr, expected, label);
    assert.doesNotMatch(result.stdout, /Downloading Nymrel Remote/, label);
  }

  const narrow = spawnSync('powershell.exe', [
    ...baseArgs, '-AllowedDirectory', path.dirname(script)
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(narrow.status, 0, narrow.error?.message ?? narrow.stderr);
  assert.match(narrow.stdout, /NYMREL_REMOTE_BOOTSTRAP_PREFLIGHT=OK/);
  assert.doesNotMatch(narrow.stdout, /Downloading Nymrel Remote/);
});

test('ChatGPTStudio bootstrap refuses a junction that aliases the user profile', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-studio-root-test-'));
  const alias = path.join(temporary, 'profile-alias');
  try {
    await fs.symlink(os.homedir(), alias, 'junction');
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(bootstrapPath),
      '-InstanceName', 'ChatGPTStudio', '-TaskName', 'Nymrel Remote ChatGPT Studio',
      '-PreflightOnly', '-AllowedDirectory', alias
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /cannot traverse a linked path/);
    assert.doesNotMatch(result.stdout, /Downloading Nymrel Remote/);
  } finally {
    await fs.unlink(alias).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temporary);
  }
});
