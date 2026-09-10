import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneDurablePayloads } from '../src/retention.js';

test('retention cleanup removes old encrypted payload records but preserves audit receipts and active work', async () => {
  const now = Date.parse('2026-09-10T03:00:00.000Z');
  const state = {
    calls: {
      old_completed: {
        id: 'old_completed', status: 'completed', completedAt: '2026-09-08T00:00:00.000Z',
        expiresAt: '2026-09-08T00:05:00.000Z', args: { ciphertext: 'encrypted-args' }, result: { ciphertext: 'encrypted-result' }
      },
      recent_completed: {
        id: 'recent_completed', status: 'completed', completedAt: '2026-09-10T02:30:00.000Z',
        expiresAt: '2026-09-10T02:35:00.000Z', args: { ciphertext: 'keep' }, result: { ciphertext: 'keep' }
      },
      old_expired: {
        id: 'old_expired', status: 'expired', completedAt: null, expiresAt: '2026-09-08T01:00:00.000Z',
        args: { ciphertext: 'encrypted-expired-args' }, result: null
      },
      active_queued: {
        id: 'active_queued', status: 'queued', createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-10T03:05:00.000Z', args: { ciphertext: 'active' }, result: null
      }
    },
    pairings: {
      old_consumed: { status: 'consumed', consumedAt: '2026-09-10T01:00:00.000Z', deviceToken: { ciphertext: 'old-token' } },
      recent_consumed: { status: 'consumed', consumedAt: '2026-09-10T02:30:00.000Z', deviceToken: { ciphertext: 'recent-token' } },
      old_expired: { status: 'expired', expiresAt: '2026-09-10T01:00:00.000Z' },
      pending: { status: 'pending', expiresAt: '2026-09-10T03:10:00.000Z' }
    },
    receipts: [{ hash: 'audit-chain-kept' }]
  };
  const runtime = {
    store: { async transaction(mutator) { return mutator(state); } }
  };
  const result = await pruneDurablePayloads(runtime, {
    callRetentionMs: 24 * 60 * 60 * 1000,
    pairingRetentionMs: 60 * 60 * 1000
  }, now);

  assert.deepEqual(result, { prunedCalls: 2, prunedPairings: 2 });
  assert.equal(state.calls.old_completed, undefined);
  assert.equal(state.calls.old_expired, undefined);
  assert.ok(state.calls.recent_completed);
  assert.ok(state.calls.active_queued);
  assert.equal(state.pairings.old_consumed, undefined);
  assert.equal(state.pairings.old_expired, undefined);
  assert.ok(state.pairings.recent_consumed);
  assert.ok(state.pairings.pending);
  assert.deepEqual(state.receipts, [{ hash: 'audit-chain-kept' }]);
});
