import test from 'node:test';
import assert from 'node:assert/strict';
import { PublisherHistoryClient, createPublisherHistoryClientFromEnv } from '../src/publisher-history-client.js';

test('Publisher history client enforces tenant-to-brand scope before service access', async () => {
  const calls = [];
  const client = createPublisherHistoryClientFromEnv({
    env: {
      NYMREL_PUBLISHER_HISTORY_URL: 'https://history.nymrel.test',
      NYMREL_PUBLISHER_HISTORY_TOKEN: 't'.repeat(48),
      NYMREL_PUBLISHER_HISTORY_TENANT_BRANDS: JSON.stringify({ t1: ['draftadynasty', 'nymrel'] })
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: [{ externalId: '123' }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.ok(client instanceof PublisherHistoryClient);

  const result = await client.listRecent('t1', { brandId: 'draftadynasty', channel: 'x', limit: 10 });
  assert.deepEqual(result, [{ externalId: '123' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://history.nymrel.test/v1/history/recent');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${'t'.repeat(48)}`);

  await assert.rejects(
    client.listRecent('t1', { brandId: 'other-brand', channel: 'x', limit: 10 }),
    (error) => error?.code === 'PUBLISHER_HISTORY_BRAND_DENIED'
  );
  assert.equal(calls.length, 1, 'denied brand must never reach the service');
});

test('Publisher history client is disabled unless all service configuration is present', () => {
  assert.equal(createPublisherHistoryClientFromEnv({ env: {} }), null);
  assert.throws(() => createPublisherHistoryClientFromEnv({
    env: { NYMREL_PUBLISHER_HISTORY_URL: 'https://history.nymrel.test' }
  }), /must be configured together/);
});

test('Publisher history client permits private Railway HTTP but rejects public plaintext origins', () => {
  const mapping = new Map([['t1', new Set(['draftadynasty'])]]);
  assert.doesNotThrow(() => new PublisherHistoryClient({
    baseUrl: 'http://nymrel-publisher-history-runtime.railway.internal:8788',
    token: 'x'.repeat(48),
    tenantBrands: mapping,
    fetchImpl: async () => { throw new Error('not called'); }
  }));
  assert.throws(() => new PublisherHistoryClient({
    baseUrl: 'http://example.com',
    token: 'x'.repeat(48),
    tenantBrands: mapping,
    fetchImpl: async () => { throw new Error('not called'); }
  }), /configuration is invalid/);
});
