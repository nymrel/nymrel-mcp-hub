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

test('expected manifest and plan hashes fail closed before job execution', async () => {
  await withRoot(async (root) => {
    let executions = 0;
    const base = {
      repoRoot: root,
      repository: 'nymrel/example',
      commitSha: sha,
      manifest,
      git: fakeGit(root),
      executeJob: async () => {
        executions += 1;
        return { status: 'success', exitCode: 0, durationMs: 1 };
      }
    };
    await assert.rejects(
      () => runTrustedCiCheckout({ ...base, expectedManifestHash: '0'.repeat(64) }),
      /manifest hash mismatch/
    );
    await assert.rejects(
      () => runTrustedCiCheckout({ ...base, expectedPlanHash: 'f'.repeat(64) }),
      /plan hash mismatch/
    );
    assert.equal(executions, 0);
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

for (const trigger of ['deadline', 'output_limit']) {
  test(`real shell job ${trigger} terminates its descendant and settles promptly`, async () => {
    await withRoot(async (root) => {
      const marker = path.join(root, 'late-side-effect');
      await fs.writeFile(path.join(root, 'descendant.cjs'), `
        const fs = require('node:fs');
        setTimeout(() => fs.writeFileSync('late-side-effect', 'escaped termination'), 2200);
        setTimeout(() => {}, 4000);
      `);
      await fs.writeFile(path.join(root, 'parent.cjs'), `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['descendant.cjs'], { stdio: 'inherit' });
        ${trigger === 'output_limit' ? "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));" : ''}
        setTimeout(() => {}, 4000);
      `);
      const started = Date.now();
      const receipt = await runTrustedCiCheckout({
        repoRoot: root, repository: 'nymrel/fixture', commitSha: sha,
        git: fakeGit(root),
        manifest: { version: 1, jobs: [{
          id: 'process-tree', command: `"${process.execPath}" parent.cjs`,
          timeoutSeconds: trigger === 'deadline' ? 1 : 10
        }] }
      });
      assert.equal(receipt.jobs[0].status, trigger === 'deadline' ? 'timed_out' : 'output_limit');
      assert.equal(receipt.conclusion, 'failure');
      assert.ok(Date.now() - started < 3000, 'must not wait for the 4-second descendant lifetime');
      // Observe beyond its scheduled write, not just immediately after kill.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2700 - (Date.now() - started))));
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    });
  });
}

test('deadline settlement stays bounded when POSIX group termination fails', {
  skip: process.platform === 'win32'
}, async (t) => {
  await withRoot(async (root) => {
    await fs.writeFile(path.join(root, 'wait.cjs'), 'setTimeout(() => {}, 4000);');
    const kill = process.kill.bind(process);
    let ownedGroup;
    const mockedKill = t.mock.method(process, 'kill', (pid) => {
      ownedGroup = pid;
      throw new Error('fixture termination failure');
    });
    try {
      const started = Date.now();
      const receipt = await runTrustedCiCheckout({
        repoRoot: root, repository: 'nymrel/fixture', commitSha: sha,
        git: fakeGit(root), manifest: { version: 1, jobs: [{
          id: 'cleanup-failure', command: `"${process.execPath}" wait.cjs`, timeoutSeconds: 1
        }] }
      });
      assert.equal(receipt.jobs[0].status, 'timed_out');
      assert.ok(Date.now() - started < 3000, 'settlement must not depend on child close');
      assert.ok(Number.isInteger(ownedGroup) && ownedGroup < -1);
    } finally {
      mockedKill.mock.restore();
      // This is solely the newly spawned fixture's dedicated process group.
      if (Number.isInteger(ownedGroup) && ownedGroup < -1) {
        try { kill(ownedGroup, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  });
});
