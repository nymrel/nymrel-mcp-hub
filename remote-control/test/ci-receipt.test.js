import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTrustedCiReceipt, verifyTrustedCiReceipt } from '../src/ci-receipt.js';
import { sha256 } from '../src/crypto.js';

function receipt(overrides = {}) {
  const body = {
    schema: 'nymrel.ci.trusted/v1',
    repository: 'nymrel/example',
    commitSha: 'a'.repeat(40),
    sourceTrust: 'trusted_studio',
    runner: { hostname: 'runner-1', platform: 'linux', arch: 'x64' },
    manifestHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64),
    startedAt: '2026-09-25T00:00:00.000Z',
    completedAt: '2026-09-25T00:00:01.000Z',
    conclusion: 'success',
    jobs: [{
      id: 'verify',
      status: 'success',
      exitCode: 0,
      durationMs: 1000,
      stdoutHash: 'd'.repeat(64),
      stderrHash: 'e'.repeat(64)
    }],
    ...overrides
  };
  return { ...body, receiptHash: sha256(body) };
}

test('trusted CI receipt verifies its digest and expected identity', () => {
  const value = receipt();
  assert.equal(verifyTrustedCiReceipt(value, {
    repository: 'nymrel/example',
    commitSha: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64)
  }), value);
});

test('trusted CI receipt rejects tampering and wrong expected identity', () => {
  const value = receipt();
  assert.throws(
    () => verifyTrustedCiReceipt({ ...value, runner: { ...value.runner, hostname: 'tampered-runner' } }),
    /hash mismatch/
  );
  assert.throws(
    () => verifyTrustedCiReceipt(value, { commitSha: 'f'.repeat(40) }),
    /commitSha does not match/
  );
});

test('trusted CI receipt rejects internally inconsistent evidence even when rehashed', () => {
  assert.throws(
    () => verifyTrustedCiReceipt(receipt({
      conclusion: 'success',
      jobs: [{
        id: 'verify',
        status: 'failed',
        exitCode: 1,
        durationMs: 5,
        stdoutHash: 'd'.repeat(64),
        stderrHash: 'e'.repeat(64)
      }]
    })),
    /conclusion does not match/
  );

  assert.throws(
    () => verifyTrustedCiReceipt(receipt({
      jobs: [
        { id: 'verify', status: 'success', exitCode: 0, durationMs: 1, stdoutHash: 'd'.repeat(64), stderrHash: 'e'.repeat(64) },
        { id: 'verify', status: 'success', exitCode: 0, durationMs: 1, stdoutHash: 'd'.repeat(64), stderrHash: 'e'.repeat(64) }
      ]
    })),
    /duplicate job id/
  );

  assert.throws(
    () => verifyTrustedCiReceipt(receipt({
      startedAt: '2026-09-25T00:00:02.000Z',
      completedAt: '2026-09-25T00:00:01.000Z'
    })),
    /precedes startedAt/
  );
});

test('extractor uses the final receipt marker and validates the payload', () => {
  const old = receipt({ commitSha: '1'.repeat(40) });
  const current = receipt();
  const output = [
    'test output',
    `NYMREL_CI_RECEIPT ${JSON.stringify(old)}`,
    'retry output',
    `NYMREL_CI_RECEIPT ${JSON.stringify(current)}`,
    ''
  ].join('\n');
  const parsed = extractTrustedCiReceipt(output, { commitSha: 'a'.repeat(40) });
  assert.equal(parsed.receiptHash, current.receiptHash);
});

test('extractor rejects missing and malformed receipt markers', () => {
  assert.throws(() => extractTrustedCiReceipt('plain output'), /marker not found/);
  assert.throws(() => extractTrustedCiReceipt('NYMREL_CI_RECEIPT not-json'), /not valid JSON/);
});
