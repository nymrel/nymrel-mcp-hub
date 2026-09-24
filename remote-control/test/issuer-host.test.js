import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireIssuerOwner, installIssuerHost, listenOwnedIssuer } from '../src/issuer-host.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'issuer-host-'));
  await mkdir(join(root, 'oidc'));
  const databasePath = join(root, 'oidc', 'issuer.sqlite');
  const file = join(root, 'private.json');
  await writeFile(file, JSON.stringify({ issuer: 'https://issuer.example', databasePath }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, databasePath, env: { NYMREL_REMOTE_OIDC_ISSUER_ENABLED: 'true', NYMREL_OIDC_CONFIG_FILE: file, NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT: root } };
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const remote = () => createServer((_req, res) => { res.writeHead(200); res.end('remote'); });

test('disabled default never loads an issuer or changes the Remote listener', async t => {
  const server = remote(); const original = server.listeners('request')[0];
  assert.equal(await installIssuerHost(server, {}, { env: {} }), null);
  assert.equal(server.listeners('request')[0], original);
  const url = await listen(t, server);
  assert.equal(await (await fetch(`${url}/readyz`)).text(), 'remote');
  await assert.rejects(installIssuerHost(server, {}, { env: { NYMREL_REMOTE_OIDC_ISSUER_ENABLED: '1' } }));
});

test('issuer routing is exact, forwarding is sanitized, and lost storage fails readiness closed', async t => {
  const f = await fixture(t); const server = remote(); let healthy = true;
  const host = await installIssuerHost(server, { publicBaseUrl: 'https://issuer.example' }, { env: f.env, createApp: async () => ({
    health() { if (!healthy) throw new Error('storage failed'); }, close() {},
    handler(req, res) { res.end(JSON.stringify(req.headers)); }
  }) });
  const url = await listen(t, server);
  for (const route of ['/mcp', '/chatgpt/mcp', '/nymrel/plugin/readonly/mcp', '/.well-known/oauth-protected-resource/mcp', '/', '/authentic', '/token/extra']) {
    assert.equal(await (await fetch(url + route)).text(), 'remote', route);
  }
  for (const route of ['/auth', '/auth/resume', '/interaction/example', '/google/callback', '/jwks', '/.well-known/openid-configuration', '/session/end', '/session/end/confirm', '/session/end/success']) {
    const headers = await (await fetch(url + route, { headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example' } })).json();
    assert.equal(headers.host, 'issuer.example'); assert.equal(headers['x-forwarded-proto'], 'https'); assert.equal(headers.forwarded, undefined);
  }
  assert.equal((await fetch(url + '/readyz')).status, 200);
  healthy = false;
  assert.equal((await fetch(url + '/readyz')).status, 503);
  assert.equal((await fetch(url + '/healthz')).status, 503);
  assert.equal((await fetch(url + '/auth')).status, 503);
  assert.equal(await (await fetch(url + '/mcp')).text(), 'remote');
  await host.close();
});

test('second process cannot own storage; clean release permits restart; crash marker stays closed', async t => {
  const f = await fixture(t); const owner = await acquireIssuerOwner(f.databasePath);
  const moduleUrl = new URL('../src/issuer-host.js', import.meta.url).href;
  const attempt = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireIssuerOwner } from ${JSON.stringify(moduleUrl)}; await acquireIssuerOwner(${JSON.stringify(f.databasePath)});`]);
  assert.notEqual(attempt().status, 0);
  await owner.release();
  assert.equal(attempt().status, 0); // process exits without release, simulating stale ownership
  assert.notEqual(attempt().status, 0, 'stale ownership must not be silently stolen');
  await assert.rejects(acquireIssuerOwner(f.databasePath), { code: 'EEXIST' });
});

test('clean host restart restores readiness and ownership loss cannot delete another marker', async t => {
  const f = await fixture(t);
  const options = { env: f.env, createApp: async () => ({ health() {}, close() {}, handler(_req, res) { res.end('issuer'); } }) };
  const first = await installIssuerHost(remote(), { publicBaseUrl: 'https://issuer.example' }, options);
  await first.ready(); await first.close();
  const second = await installIssuerHost(remote(), { publicBaseUrl: 'https://issuer.example' }, options);
  await second.ready();
  const marker = `${f.databasePath}.owner`;
  await writeFile(marker, '{"owner":"replacement"}');
  await assert.rejects(second.ready()); await assert.rejects(second.close());
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).owner, 'replacement');
});

test('standalone bind failure closes the issuer and releases storage for a retry', async t => {
  const f = await fixture(t); const occupied = remote(); await listen(t, occupied);
  const owner = await acquireIssuerOwner(f.databasePath); let closed = false;
  await assert.rejects(listenOwnedIssuer(remote(), { close() { closed = true; } }, owner, occupied.address().port), { code: 'EADDRINUSE' });
  assert.equal(closed, true);
  const retryOwner = await acquireIssuerOwner(f.databasePath); await retryOwner.release();
});
