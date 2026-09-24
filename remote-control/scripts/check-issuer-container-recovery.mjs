#!/usr/bin/env node
// Fixture-only production-image proof. No published ports, accounts or egress.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] || 'nymrel-remote:ci';
assert.match(image, /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/, 'Supply an existing local image name');
const prefix = `nymrel-issuer-fixture-${randomBytes(8).toString('hex')}`;
const volume = `${prefix}-data`;
const primary = `${prefix}-primary`;
const contender = `${prefix}-contender`;
const fixtureDirectory = fileURLToPath(new URL('../fixtures/', import.meta.url));
const containers = new Set();
let volumeCreated = false;

function docker(args, { allowFailure = false, timeout = 20_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || (result.status !== 0 && !allowFailure)) {
    // Inputs can contain generated fixture material. Do not echo commands/config.
    throw new Error(`Docker ${args[0]} failed: ${result.error?.message || result.stderr.trim() || result.signal || result.status}`);
  }
  return result;
}

const mounts = () => ['--mount', `type=volume,source=${volume},target=/data`,
  '--mount', `type=bind,source=${fixtureDirectory},target=/fixture,readonly`];
const fixture = (name, command, ...args) => docker(['exec', '--user', '1000:1000', name,
  'node', '/fixture/issuer-container.mjs', command, ...args]);
function run(name, extraEnv = []) {
  containers.add(name);
  docker(['run', '--detach', '--pull=never', '--name', name, '--network=none', ...mounts(),
    '-e', 'NYMREL_REMOTE_PUBLIC_URL=https://issuer.example.test',
    '-e', 'NYMREL_REMOTE_AUTHORIZATION_SERVERS=https://issuer.example.test',
    '-e', 'NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS={"fixture-account":"fixture-tenant"}',
    '-e', 'NYMREL_REMOTE_OIDC_ISSUER_ENABLED=true', '-e', 'NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED=false',
    '-e', 'NYMREL_REMOTE_INSTANCE_LEASE_TTL_MS=5000', '-e', 'NYMREL_OIDC_CONFIG_FILE=/data/fixture/issuer.json',
    '-e', 'NYMREL_CONTAINER_FIXTURE_PRELOAD=true', '-e', 'NODE_OPTIONS=--import=/fixture/issuer-container.mjs',
    ...extraEnv, image]);
}
async function ready(name, { empty = false } = {}) {
  const deadline = Date.now() + 35_000;
  let lastError;
  while (Date.now() < deadline) {
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim(), 'true', 'Container exited before readiness');
    try { return JSON.parse(fixture(name, 'snapshot', ...(empty ? ['--empty'] : [])).stdout); }
    catch (error) { lastError = error; await delay(250); }
  }
  throw new Error(`Container did not become ready: ${lastError?.message}`);
}

try {
  assert.equal(docker(['info', '--format', '{{.OSType}}']).stdout.trim(), 'linux', 'A Linux Docker daemon is required');
  docker(['image', 'inspect', image]); // Never pull an image or start Docker implicitly.
  docker(['volume', 'create', '--label', 'nymrel.fixture=issuer-recovery', volume]);
  volumeCreated = true;
  docker(['run', '--rm', '--pull=never', '--network=none', ...mounts(), '--entrypoint', 'node', image,
    '/fixture/issuer-container.mjs', 'initialize']);
  run(primary);
  await ready(primary, { empty: true });
  fixture(primary, 'interaction');
  const before = await ready(primary);
  console.log('ok enabled issuer, private storage, runtime UID and real pre-login interaction');

  // A separate Remote store makes this fail at issuer SQLite ownership, rather
  // than at the unrelated Remote instance lease protecting state.json.
  run(contender, ['-e', 'NYMREL_REMOTE_STORE=/data/contender.json']);
  const contenderExit = docker(['wait', contender], { timeout: 15_000 }).stdout.trim();
  assert.notEqual(contenderExit, '0', 'Second issuer must fail startup');
  const logs = docker(['logs', contender]);
  assert.match(logs.stdout + logs.stderr, /database is locked/, 'Must fail at SQLite ownership');
  assert.deepEqual(await ready(primary), before, 'Rejected contender must not affect the first owner');
  console.log('ok second container rejected by issuer ownership lock');

  docker(['stop', '--time', '10', primary]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', primary]).stdout.trim(), '0', 'Clean stop must exit normally');
  docker(['rm', primary]);
  containers.delete(primary);
  run(primary);
  assert.deepEqual(await ready(primary), before, 'Replacement container must recover interaction, keys and ownership file from the named volume');
  console.log('ok replacement container recovers private storage and public signing keys from the same named volume');

  docker(['kill', '--signal=KILL', primary]);
  assert.equal(docker(['wait', primary]).stdout.trim(), '137', 'Forced termination must be observed');
  docker(['start', primary]);
  assert.deepEqual(await ready(primary), before, 'Crash recovery must retain interaction, keys and ownership file');
  console.log('ok forced restart recovers the same persistent volume without replacing the ownership database');
  console.log('PASS fixture container recovery; Google login, issued tokens and ChatGPT reads remain unvalidated');
} finally {
  const failures = [];
  for (const name of [...containers].reverse()) {
    try { docker(['rm', '--force', name]); } catch (error) { failures.push(error.message); }
  }
  if (volumeCreated) {
    try { docker(['volume', 'rm', volume]); } catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(`Fixture cleanup failed: ${failures.join('; ')}`);
}
