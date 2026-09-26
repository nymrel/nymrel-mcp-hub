import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/crypto.js';
import { readTrustedCiState, writeTrustedCiFinal, writeTrustedCiRunning } from '../src/ci-state.js';

const runId = '1'.repeat(64);
const identity = {
  repository: 'nymrel/example',
  commitSha: 'a'.repeat(40),
  manifestHash: 'b'.repeat(64),
  planHash: 'c'.repeat(64)
};

function receipt(overrides = {}) {
  const body = {
    schema: 'nymrel.ci.trusted/v1',
    repository: identity.repository,
    commitSha: identity.commitSha,
    sourceTrust: 'trusted_studio',
    runner: { hostname: 'runner-1', platform: 'linux', arch: 'x64' },
    manifestHash: identity.manifestHash,
    planHash: identity.planHash,
    startedAt: '2026-09-25T00:00:00.000Z',
    completedAt: '2026-09-25T00:00:01.000Z',
    conclusion: 'success',
    jobs: [{
      id: 'verify',
      status: 'success',
      exitCode: 0,
      durationMs: 1000,
      stdoutBytes: 10,
      stderrBytes: 0,
      stdoutHash: 'd'.repeat(64),
      stderrHash: 'e'.repeat(64)
    }],
    ...overrides
  };
  return { ...body, receiptHash: sha256(body) };
}

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-ci-state-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('running state is recoverable and final verified state takes precedence', async () => {
  await withDirectory(async (directory) => {
    const running = await writeTrustedCiRunning(directory, { runId, identity });
    assert.equal(running.status, 'running');
    assert.equal((await readTrustedCiState(directory, runId)).status, 'running');

    const final = await writeTrustedCiFinal(directory, {
      runId,
      identity,
      receipt: receipt(),
      exitCode: 0
    });
    assert.equal(final.status, 'verified');
    const recovered = await readTrustedCiState(directory, runId);
    assert.equal(recovered.status, 'verified');
    assert.equal(recovered.receipt.conclusion, 'success');
    assert.equal(recovered.identity.planHash, identity.planHash);
  });
});

test('invalid terminal state persists bounded failure metadata without logs', async () => {
  await withDirectory(async (directory) => {
    await writeTrustedCiRunning(directory, { runId, identity });
    await writeTrustedCiFinal(directory, {
      runId,
      identity,
      exitCode: 1,
      error: 'process ended before receipt'
    });
    const recovered = await readTrustedCiState(directory, runId);
    assert.equal(recovered.status, 'invalid');
    assert.equal(recovered.error, 'process ended before receipt');
    assert.equal(recovered.receipt, undefined);
  });
});

test('receipt identity mismatch is rejected before final state is written', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(
      () => writeTrustedCiFinal(directory, {
        runId,
        identity,
        receipt: receipt({ commitSha: 'f'.repeat(40) }),
        exitCode: 0
      }),
      /commitSha does not match/
    );
    assert.equal(await readTrustedCiState(directory, runId), null);
  });
});

test('state record corruption is rejected and missing runs return null', async () => {
  await withDirectory(async (directory) => {
    await writeTrustedCiRunning(directory, { runId, identity });
    const file = path.join(directory, `${runId}.running.json`);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    parsed.identity.repository = 'nymrel/tampered';
    await fs.writeFile(file, JSON.stringify(parsed), 'utf8');
    await assert.rejects(() => readTrustedCiState(directory, runId), /record hash mismatch/);
    assert.equal(await readTrustedCiState(directory, '2'.repeat(64)), null);
  });
});
