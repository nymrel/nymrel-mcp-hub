import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdditionalClients, validateAdditionalClients, VERCEL_CALLBACK } from '../src/additional-clients.js';

const primaryId = 'existing-primary-client';

test('additional client parser accepts one explicit public Vercel client and no secrets', () => {
  const raw = JSON.stringify([{ clientId: 'vercel-fixture', callback: VERCEL_CALLBACK }]);
  assert.deepEqual(parseAdditionalClients(raw, primaryId), [{ clientId: 'vercel-fixture', callback: VERCEL_CALLBACK }]);
  const [client] = validateAdditionalClients([{ clientId: 'vercel-fixture', callback: VERCEL_CALLBACK }], primaryId);
  assert.deepEqual(client, {
    client_id: 'vercel-fixture', redirect_uris: [VERCEL_CALLBACK], token_endpoint_auth_method: 'none',
    response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], scope: 'openid offline_access devices:read tools:read'
  });
});

test('additional client configuration rejects broad, ambiguous, or credential-bearing input', () => {
  for (const input of [
    'not-json', '', '{}', 'null',
    JSON.stringify([{ clientId: 'vercel-fixture', callback: 'https://example.com/callback' }]),
    JSON.stringify([{ clientId: primaryId, callback: VERCEL_CALLBACK }]),
    JSON.stringify([{ clientId: 'vercel-fixture', callback: VERCEL_CALLBACK, clientSecret: 'must-not-be-accepted' }]),
    JSON.stringify([{ clientId: 'one', callback: VERCEL_CALLBACK }, { clientId: 'two', callback: VERCEL_CALLBACK }])
  ]) assert.throws(() => parseAdditionalClients(input, primaryId));
});

test('additional client identifiers and callbacks must be exact', () => {
  assert.throws(() => validateAdditionalClients([{ clientId: '', callback: VERCEL_CALLBACK }], primaryId));
  assert.throws(() => validateAdditionalClients([{ clientId: 'vercel fixture', callback: VERCEL_CALLBACK }], primaryId));
  assert.throws(() => validateAdditionalClients([{ clientId: 'vercel\nfixture', callback: VERCEL_CALLBACK }], primaryId));
  assert.throws(() => validateAdditionalClients([{ clientId: 'x'.repeat(129), callback: VERCEL_CALLBACK }], primaryId));
  assert.throws(() => validateAdditionalClients([{ clientId: 'vercel-fixture', callback: `${VERCEL_CALLBACK}/` }], primaryId));
});
