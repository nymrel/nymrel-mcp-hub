// Exercises the mounted fixture against the real issuer on any supported Node24
// host. Linux UID, mounted-volume and container restart proof stays in Docker CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, fixtureFetch, GOOGLE_DISCOVERY, ISSUER, createInteraction } from '../../fixtures/issuer-container.mjs';
import { installIssuerHost } from '../../src/issuer-host.js';

test('container preload supplies only exact Google discovery and loopback requests', async () => {
  let localCalls = 0;
  const fetchFixture = fixtureFetch(async () => { localCalls++; return new Response('local'); });
  assert.equal((await (await fetchFixture(GOOGLE_DISCOVERY)).json()).issuer, 'https://accounts.google.com');
  for (const input of [GOOGLE_DISCOVERY + '?unexpected=1', 'https://accounts.google.com/authorize',
    'https://oauth2.googleapis.com/token', 'http://127.0.0.1:8788/',
    new Request(GOOGLE_DISCOVERY, { method: 'POST' })]) {
    await assert.rejects(fetchFixture(input), /forbids external requests/);
  }
  await assert.rejects(fetchFixture(GOOGLE_DISCOVERY, { method: 'POST' }), /forbids external requests/);
  assert.equal(localCalls, 0);
  assert.equal(await (await fetchFixture('http://127.0.0.1:8787/readyz')).text(), 'local');
  assert.equal(localCalls, 1);
});

test('generated private fixture starts the real issuer and stores only pre-login state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nymrel-container-fixture-'));
  const realFetch = globalThis.fetch;
  let server, host;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await host?.close();
    } finally {
      globalThis.fetch = realFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
  await initialize(root, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
  const configPath = join(root, 'fixture', 'issuer.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.offline, undefined, 'Fixture must use production mode');
  const runtime = JSON.parse(await readFile(join(root, 'fixture', 'runtime.json'), 'utf8'));
  assert.equal(new Set(Object.values(runtime)).size, 4, 'Runtime credentials must be independently generated');
  assert.ok(Object.values(runtime).every(value => /^[a-f0-9]{64}$/.test(value)));
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  globalThis.fetch = fixtureFetch(realFetch);
  host = await installIssuerHost(server, { publicBaseUrl: ISSUER }, { env: {
    NYMREL_REMOTE_OIDC_ISSUER_ENABLED: 'true', NYMREL_OIDC_CONFIG_FILE: configPath,
    NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT: root
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = fixtureFetch(realFetch, origin);
  await host.ready();
  await createInteraction(origin);
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    const models = db.prepare('SELECT DISTINCT model FROM oidc ORDER BY model').all().map(row => row.model);
    assert.deepEqual(models, ['BrowserInteractionBinding', 'Interaction']);
  } finally { db.close(); }
});
