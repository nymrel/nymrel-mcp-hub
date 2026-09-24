import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore, PRUNE_BATCH_SIZE } from '../src/sqlite-adapter.js';
import { startStorageMaintenance, PRUNE_INTERVAL_MS } from '../src/storage-maintenance.js';
import { createIssuerHttp } from '../src/http.js';

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'nymrel-expiry-'));
  const filename = join(directory, 'issuer.sqlite');
  return { filename, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('bounded indexed pruning physically deletes expired rows and preserves live authorization across restart', async t => {
  const { filename, cleanup } = await database();
  let store = createSqliteStore(filename);
  const inspector = new DatabaseSync(filename);
  t.after(async () => { inspector.close(); store.close(); await cleanup(); });
  const count = () => inspector.prepare('SELECT count(*) AS count FROM oidc').get().count;
  const models = ['Interaction', 'BrowserInteractionBinding', 'AuthorizationCode', 'RefreshToken', 'Grant', 'Session'];
  for (let index = 0; index < PRUNE_BATCH_SIZE + 3; index++) {
    await new store.Adapter(models[index % models.length]).upsert(`expired-${index}`, { secret: 'expired-fixture' }, -1);
  }
  for (const model of models) await new store.Adapter(model).upsert('live', { grantId: 'live-grant', value: model }, 86400);
  await new store.Adapter('Session').upsert('without-expiry', { value: 'retained' });
  assert.ok(inspector.prepare("PRAGMA index_list('oidc')").all().some(row => row.name === 'oidc_expires'));
  assert.match(inspector.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM oidc WHERE expires IS NOT NULL AND expires<=? ORDER BY expires LIMIT ?').all(0, PRUNE_BATCH_SIZE).map(row => row.detail).join(' '), /oidc_expires/);
  assert.equal(store.prune().changes, PRUNE_BATCH_SIZE);
  assert.equal(count(), models.length + 4);
  store.close(); store = createSqliteStore(filename);
  assert.equal(store.prune().changes, 3);
  assert.equal(store.prune().changes, 0);
  assert.equal(count(), models.length + 1);
  for (const model of models) assert.equal((await new store.Adapter(model).find('live')).value, model);
  assert.equal((await new store.Adapter('Session').find('without-expiry')).value, 'retained');
});

test('maintenance runs at startup and periodically, stops on close, and makes failures sticky', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0, fail = false;
  const maintenance = startStorageMaintenance({ prune() { calls++; if (fail) throw new Error('private database detail'); } });
  assert.equal(calls, 1);
  t.mock.timers.tick(PRUNE_INTERVAL_MS - 1); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.equal(calls, 2);
  maintenance.health();
  fail = true; t.mock.timers.tick(PRUNE_INTERVAL_MS);
  assert.equal(calls, 3);
  assert.throws(() => maintenance.health(), /^Error: Issuer storage maintenance unavailable$/);
  fail = false; t.mock.timers.tick(PRUNE_INTERVAL_MS * 3);
  assert.equal(calls, 3);
  assert.throws(() => maintenance.health());
  maintenance.close(); maintenance.close();
  let closedCalls = 0;
  const closing = startStorageMaintenance({ prune() { closedCalls++; } });
  closing.close(); t.mock.timers.tick(PRUNE_INTERVAL_MS * 3);
  assert.equal(closedCalls, 1);
  assert.throws(() => closing.health());
  assert.throws(() => startStorageMaintenance({ prune() { throw new Error('startup write failure'); } }), /startup write failure/);
});

test('HTTP lifecycle prunes abandoned storage, reports failed maintenance, and restarts without a leftover scheduler', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { filename, cleanup } = await database();
  const seed = createSqliteStore(filename);
  for (let i = 0; i <= PRUNE_BATCH_SIZE; i++) await new seed.Adapter('BrowserInteractionBinding').upsert(`abandoned-${i}`, { stage: 'login' }, -1);
  await new seed.Adapter('Grant').upsert('live', { accountId: 'fixture-operator' }, 86400);
  seed.close();
  const inspector = new DatabaseSync(filename);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const config = {
    issuer: 'http://127.0.0.1', offline: true, clientId: 'fixture-chatgpt', callback: 'https://chatgpt.com/connector/oauth/fixture',
    identity: { issuer: 'https://accounts.google.com', subject: 'fixture-google', accountId: 'fixture-operator' },
    jwks: { keys: [{ ...key, kid: 'fixture', alg: 'RS256' }] }, cookieKeys: [randomBytes(32).toString('hex')],
    databasePath: filename, google: { clientId: 'fixture-google-client', clientSecret: 'fixture-secret' }
  };
  const options = { googleFetch: async input => {
    assert.equal(String(input), 'https://accounts.google.com/.well-known/openid-configuration');
    return new Response(JSON.stringify({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://accounts.google.com/token', jwks_uri: 'https://accounts.google.com/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }), { headers: { 'content-type': 'application/json' } });
  } };
  let app;
  const server = createServer((req, res) => app.handler(req, res));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app?.close(); inspector.close(); await cleanup(); });
  app = await createIssuerHttp(config, options);
  const count = () => inspector.prepare('SELECT count(*) AS count FROM oidc').get().count;
  assert.equal(count(), 2, 'startup processes only one bounded batch');
  t.mock.timers.tick(PRUNE_INTERVAL_MS);
  assert.equal(count(), 1); app.health();
  app.close(); app.close();
  t.mock.timers.tick(PRUNE_INTERVAL_MS * 2);
  app = await createIssuerHttp(config, options);
  app.health(); assert.equal(count(), 1);
  inspector.exec('DROP TABLE oidc');
  t.mock.timers.tick(PRUNE_INTERVAL_MS);
  assert.throws(() => app.health(), /maintenance unavailable/);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/auth`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Service unavailable');
});
