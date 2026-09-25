import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSafeCiEnvironment, runTrustedCiCheckout } from '../src/ci-local-runner.js';

const sha = 'a'.repeat(40);
const manifest = {
  version: 1,
  jobs: [
    { id: 'one', command: 'first' },
    { id: 'two', command: 'second', dependsOn: ['one'] }
  ]
};

async function withRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-ci-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function fakeGit(root, { head = sha, dirty = '' } = {}) {
  return async (_file, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return root;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'status') return dirty;
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

test('trusted runner source contains no escaped source newline artifact', async () => {
  const source = await fs.readFile(new URL('../src/ci-local-runner.js', import.meta.url), 'utf8');
  assert.equal(source.includes('resolveJobCwd(job.cwd);\\n'), false);
  assert.match(source, /const resolveJobCwd = async/);
});

test('safe environment keeps platform essentials and strips secret-shaped extras', () => {
  const env = buildSafeCiEnvironment({ PATH: '/bin', HOME: '/home/x', OPENAI_API_KEY: 'nope', DATABASE_URL: 'nope' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.CI, 'true');
  assert.equal(env.NYMREL_CI, '1');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('trusted checkout executes dependency order and emits deterministic evidence fields', async () => {
  await withRoot(async (root) => {
    const seen = [];
    const receipt = await runTrustedCiCheckout({
      repoRoot: root,
      repository: 'nymrel/example',
      commitSha: sha,
      manifest,
      git: fakeGit(root),
      environment: { PATH: '/bin', SECRET_TOKEN: 'hidden' },
      executeJob: async (job, context) => {
        seen.push({ id: job.id, secret: context.environment.SECRET_TOKEN });
        return { status: 'success', exitCode: 0, durationMs: 5, stdoutBytes: 1, stderrBytes: 0, stdoutHash: '1'.repeat(64), stderrHash: '2'.repeat(64) };
      }
    });
    assert.deepEqual(seen, [{ id: 'one', secret: undefined }, { id: 'two', secret: undefined }]);
    assert.equal(receipt.conclusion, 'success');
    assert.equal(receipt.jobs.length, 2);
    assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
  });
});

test('failed dependency skips dependent jobs', async () => {
  await withRoot(async (root) => {
    let calls = 0;
    const receipt = await runTrustedCiCheckout({
      repoRoot: root,
      repository: 'nymrel/example',
      commitSha: sha,
      manifest,
      git: fakeGit(root),
      executeJob: async () => {
        calls += 1;
        return { status: 'failed', exitCode: 1, durationMs: 1, stdoutHash: '1'.repeat(64), stderrHash: '2'.repeat(64) };
      }
    });
    assert.equal(calls, 1);
    assert.equal(receipt.jobs[0].status, 'failed');
    assert.equal(receipt.jobs[1].status, 'skipped_dependency');
    assert.equal(receipt.conclusion, 'failure');
  });
});

test('refuses a job cwd that resolves outside the checkout', async (t) => {
  if (process.platform === 'win32') { t.skip('symlink privilege varies on Windows'); return; }
  await withRoot(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-ci-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'escape'));
      const escapeManifest = { version: 1, jobs: [{ id: 'escape', command: 'x', cwd: 'escape' }] };
      await assert.rejects(() => runTrustedCiCheckout({
        repoRoot: root, repository: 'nymrel/example', commitSha: sha, manifest: escapeManifest,
        git: fakeGit(root), executeJob: async () => { throw new Error('must not execute'); }
      }), /escapes repository root/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('refuses mismatched or dirty checkouts before execution', async () => {
  await withRoot(async (root) => {
    const base = { repoRoot: root, repository: 'nymrel/example', commitSha: sha, manifest, executeJob: async () => { throw new Error('must not execute'); } };
    await assert.rejects(() => runTrustedCiCheckout({ ...base, git: fakeGit(root, { head: 'b'.repeat(40) }) }), /does not match expected/);
    await assert.rejects(() => runTrustedCiCheckout({ ...base, git: fakeGit(root, { dirty: ' M file.js' }) }), /must be clean/);
  });
});
