import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssuer, RESOURCE, READ_SCOPES } from '../src/issuer.js';
import { createSqliteStore } from '../src/sqlite-adapter.js';
import { OAuthAccessTokenVerifier } from '../../src/oauth.js';

const callback = 'https://chatgpt.com/connector/oauth/offline-fixture';
const identity = { issuer: 'https://accounts.google.com', subject: 'fixture-google-sub', accountId: 'fixture-operator' };
const clientId = 'nymrel-offline-chatgpt';

function assertAuthorizationRedirect(url, issuer) {
  assert.equal(`${url.origin}${url.pathname}`, callback);
  assert.equal(url.searchParams.get('state'), 'fixture-state');
  assert.equal(url.searchParams.get('iss'), issuer, 'Every advertised RFC9207 redirect must identify the issuer');
  assert.notEqual(url.searchParams.has('code'), url.searchParams.has('error'), 'Redirect must carry exactly one code or error');
}

function assertProtocolDenial(result, expected, issuer) {
  assert.ok(!result.url?.searchParams.has('code'));
  if (expected.redirect) {
    assert.ok(result.url, 'Expected an OAuth error redirect, not an HTTP error page');
    assertAuthorizationRedirect(result.url, issuer);
    assert.equal(result.url.searchParams.get('error'), expected.error);
  } else {
    assert.equal(result.url, undefined, 'Unsafe requests must not redirect');
    assert.equal(result.status, 400, 'Protocol rejection must be 400, never a server failure');
    assert.match(result.body, new RegExp(`(?:error</strong>: |^)${expected.error}(?:</pre>|$)`));
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nymrel-oidc-'));
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const key = { ...privateKey.export({ format: 'jwk' }), kid: 'fixture-signing', alg: 'RS256', use: 'sig' };
  let app;
  let loginIdentity = identity;
  let failAuthorization = false;
  const server = createServer(async (req, res) => {
    try {
      if (failAuthorization && req.url.startsWith('/auth?')) {
        failAuthorization = false; res.writeHead(500); res.end('invalid_target'); return;
      }
      // TEST ONLY. Production must implement real identity verification, consent UI and CSRF.
      if (req.url.startsWith('/interaction/')) {
        const details = await app.provider.interactionDetails(req, res);
        if (details.prompt.name === 'login') await app.completeLogin(req, res, loginIdentity);
        else await app.approveConsent(req, res);
      } else app.provider.callback()(req, res);
    } catch (error) {
      res.writeHead(error.message === 'Identity denied' ? 403 : 500); res.end('denied');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const config = { issuer, clientId, callback, identity, jwks: { keys: [key] }, cookieKeys: [randomBytes(32).toString('hex')], databasePath: join(dir, 'issuer.sqlite'), offline: true };
  app = createIssuer(config);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); await rm(dir, { recursive: true, force: true }); });
  async function authorize(overrides = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code',
      scope: `openid offline_access ${READ_SCOPES}`, resource: RESOURCE, state: 'fixture-state', prompt: 'consent',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...overrides });
    for (const [key, value] of Object.entries(overrides)) if (value === null) params.delete(key);
    let url = `${issuer}/auth?${params}`;
    const cookies = new Map();
    for (let i = 0; i < 12; i++) {
      if (url.startsWith(callback)) {
        const redirect = new URL(url);
        assertAuthorizationRedirect(redirect, issuer);
        return { url: redirect, verifier };
      }
      const response = await fetch(url, { redirect: 'manual', headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') } });
      for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
      if (!response.headers.has('location')) return { status: response.status, body: await response.text(), verifier };
      url = new URL(response.headers.get('location'), issuer).href;
    }
    throw new Error('redirect limit');
  }
  async function post(path, fields) {
    const response = await fetch(`${issuer}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : null };
  }
  const exchange = (auth, overrides = {}) => post('/token', { grant_type: 'authorization_code', client_id: clientId,
    code: auth.url?.searchParams.get('code') || '', redirect_uri: callback, code_verifier: auth.verifier, resource: RESOURCE, ...overrides });
  return { issuer, authorize, exchange, post, denyIdentity: () => { loginIdentity = { ...identity, subject: 'other' }; },
    failNextAuthorization: () => { failAuthorization = true; },
    restart: () => { app.close(); app = createIssuer(config); } };
}

test('discovery, real code exchange, audience and durable refresh/revocation', async t => {
  const f = await fixture(t);
  const metadata = await (await fetch(`${f.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(metadata.issuer, f.issuer);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.notEqual(metadata.client_id_metadata_document_supported, true);
  assert.ok(metadata.scopes_supported.includes('openid'));
  const auth = await f.authorize();
  assert.ok(auth.url?.searchParams.get('code'), JSON.stringify(auth));
  assert.equal(auth.url.searchParams.get('iss'), f.issuer);
  const token = await f.exchange(auth);
  assert.equal(token.status, 200, JSON.stringify(token));
  assert.ok(token.body.refresh_token);
  const verifier = new OAuthAccessTokenVerifier({ issuer: f.issuer, audience: RESOURCE });
  const claims = await verifier.verify(token.body.access_token);
  assert.equal(claims.aud, RESOURCE);
  assert.deepEqual(new Set(claims.scopes), new Set(READ_SCOPES.split(' ')));
  assert.equal(claims.sub, identity.accountId);
  assert.equal((await f.exchange(auth)).status, 400);
  // Code reuse revokes the grant; obtain a separate grant for persistence tests.
  const next = await f.exchange(await f.authorize());
  f.restart();
  const refresh = await f.post('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: next.body.refresh_token, resource: RESOURCE });
  assert.equal(refresh.status, 200, JSON.stringify(refresh));
  assert.notEqual(refresh.body.refresh_token, next.body.refresh_token);
  assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: next.body.refresh_token, resource: RESOURCE })).status, 400);
  // Reuse revokes the family, including the replacement.
  assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh.body.refresh_token, resource: RESOURCE })).status, 400);
  const revocable = await f.exchange(await f.authorize());
  assert.equal((await f.post('/token/revocation', { client_id: clientId, token: revocable.body.refresh_token })).status, 200);
  assert.equal((await f.post('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: revocable.body.refresh_token, resource: RESOURCE })).status, 400);
});

test('deny identity, client/callback drift, invalid resource/scope, weak PKCE and token replay', async t => {
  const f = await fixture(t);
  for (const [overrides, expected] of [
    [{ client_id: 'unknown' }, { error: 'invalid_client' }],
    [{ redirect_uri: `${callback}/other` }, { error: 'invalid_redirect_uri' }],
    [{ resource: 'https://other.example/mcp' }, { error: 'invalid_target' }],
    [{ resource: null }, { error: 'invalid_target' }],
    [{ scope: `${READ_SCOPES} tools:write` }, { error: 'invalid_scope' }],
    [{ code_challenge_method: 'plain' }, { redirect: true, error: 'invalid_request' }],
    [{ code_challenge: null }, { redirect: true, error: 'invalid_request' }]
  ]) {
    const result = await f.authorize(overrides);
    assertProtocolDenial(result, expected, f.issuer);
  }
  // A real HTTP 500 with a plausible OAuth error body must not satisfy denial acceptance.
  f.failNextAuthorization();
  const serverFailure = await f.authorize({ resource: 'https://other.example/mcp' });
  assert.equal(serverFailure.status, 500);
  assert.throws(() => assertProtocolDenial(serverFailure, { error: 'invalid_target' }, f.issuer), assert.AssertionError);
  // An error redirect with valid state but omitted issuer must also fail acceptance.
  assert.throws(() => assertAuthorizationRedirect(new URL(`${callback}?error=invalid_request&state=fixture-state`), f.issuer), assert.AssertionError);
  const auth = await f.authorize();
  assert.equal((await f.exchange(auth, { code_verifier: 'wrong'.repeat(12) })).status, 400);
  const otherResource = await f.authorize();
  assert.equal((await f.exchange(otherResource, { resource: 'https://other.example/mcp' })).status, 400);
  f.denyIdentity();
  assert.equal((await f.authorize()).status, 403);
});

test('SQLite adapter persists indexes, consumption and grant revocation across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nymrel-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = createSqliteStore(join(dir, 'store.sqlite'));
  let adapter = new store.Adapter('AuthorizationCode');
  await adapter.upsert('one', { grantId: 'grant', uid: 'uid', userCode: 'code' }, 60);
  await adapter.consume('one'); store.close();
  store = createSqliteStore(join(dir, 'store.sqlite'));
  adapter = new store.Adapter('AuthorizationCode');
  assert.ok((await adapter.findByUid('uid')).consumed);
  assert.ok((await adapter.findByUserCode('code')).consumed);
  await adapter.revokeByGrantId('grant');
  assert.equal(await adapter.find('one'), undefined);
  await adapter.upsert('expired', { value: true }, -1);
  assert.equal(await adapter.find('expired'), undefined);
  store.prune(); store.close();
});
