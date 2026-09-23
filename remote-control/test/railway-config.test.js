import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const infrastructure = readFileSync(new URL('../.railway/railway.ts', import.meta.url), 'utf8');
const watchList = infrastructure.match(/watchPatterns:\s*(\[[\s\S]*?\])/);
assert.ok(watchList, 'Railway infrastructure must declare watch paths');
const patterns = JSON.parse(watchList[1].replace(/,\s*\]$/, ']'));

// Railway documents repository-root gitignore-style matching, not service-root
// matching. Exercise those semantics with local Git rather than a custom glob
// approximation. This fixture never accesses the working repository or network.
function matchedPaths(paths) {
  const root = mkdtempSync(path.join(tmpdir(), 'nymrel-railway-watch-'));
  const emptyConfig = path.join(root, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  const run = (args, input) => {
    const result = spawnSync('git', ['-c', `core.excludesFile=${emptyConfig}`, ...args], {
      cwd: root, env, input, encoding: 'utf8', windowsHide: true,
      timeout: 10_000, maxBuffer: 64 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Git fixture must not terminate by signal');
    return result;
  };
  try {
    const initialized = run(['init', '--quiet']);
    assert.equal(initialized.status, 0, 'Git fixture initialization must succeed');
    writeFileSync(path.join(root, '.gitignore'), `${patterns.join('\n')}\n`);
    const checked = run(['check-ignore', '--no-index', '--stdin'], `${paths.join('\n')}\n`);
    assert.ok(checked.status === 0 || checked.status === 1, 'Git matching must complete');
    return checked.stdout.trim().split(/\r?\n/).filter(Boolean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Railway watch patterns are unique and confined to the repository-root service path', () => {
  assert.ok(Array.isArray(patterns) && patterns.length > 0);
  assert.equal(new Set(patterns).size, patterns.length);
  for (const pattern of patterns) {
    assert.equal(typeof pattern, 'string');
    assert.ok(pattern.startsWith('/remote-control/'), 'watch path must be service-scoped from repository root');
    assert.ok(!pattern.includes('..') && !pattern.includes('!'), 'watch paths must not escape or negate scope');
  }
});

test('remote server, device, and public asset changes are watched', () => {
  const changed = [
    'remote-control/src/server.js',
    'remote-control/src/chatgpt-server.js',
    'remote-control/src/nested/future-module.js',
    'remote-control/bin/nymrel-remote-agent.js',
    'remote-control/bin/install-nymrel-remote-windows.ps1',
    'remote-control/public/app.js'
  ];
  assert.deepEqual(matchedPaths(changed), changed);
});

test('service build inputs and Railway configuration changes are watched', () => {
  const changed = [
    'remote-control/package.json',
    'remote-control/package-lock.json',
    'remote-control/Dockerfile',
    'remote-control/.dockerignore',
    'remote-control/.railway/railway.ts'
  ];
  assert.deepEqual(matchedPaths(changed), changed);
});

test('unrelated hub and sibling service changes do not trigger this service', () => {
  assert.deepEqual(matchedPaths([
    'src/server.ts', 'bin/mcp-server.js', 'public/index.html',
    'package.json', 'package-lock.json', 'Dockerfile', 'railway.json',
    'workspace-gateway/src/server.js', 'remote-control-copy/src/server.js'
  ]), []);
});

test('documentation and test-only changes do not widen the runtime watch scope', () => {
  assert.deepEqual(matchedPaths([
    'remote-control/README.md',
    'remote-control/docs/RAILWAY_DEPLOYMENT.md',
    'remote-control/test/railway-config.test.js',
    '.github/workflows/remote-control-ci.yml'
  ]), []);
});
