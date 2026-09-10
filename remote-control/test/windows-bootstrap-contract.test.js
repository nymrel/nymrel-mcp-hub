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
  assert.match(installer, /\/RL LIMITED/);
  assert.match(bootstrap, /NYMREL_REMOTE_LOCAL_BACKEND' 'native'/);
  for (const name of forbiddenServiceSecrets) {
    assert.doesNotMatch(bootstrap, new RegExp(name));
    assert.doesNotMatch(installer, new RegExp(name));
  }
});

test('Windows bootstrap preserves credentials outside replaceable application source', () => {
  assert.match(bootstrap, /Join-Path \$runtimeDir 'device\.json'/);
  assert.match(bootstrap, /app\.staging/);
  assert.match(bootstrap, /app\.previous/);
  assert.match(guide, /preserves `device\.json`/);
});
