import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssuerHttp } from '../src/http.js';
import { RESOURCE, READ_SCOPES } from '../src/issuer.js';
import { ISSUER_RATE_LIMITS } from '../src/rate-limit.js';

const googleIssuer = 'https://accounts.google.com';
const callback = 'https://chatgpt.com/connector/oauth/mock';
const hash = value => createHash('sha256').update(value).digest('base64url');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function googleMock() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'google-mock', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  let mode, tokenRequests = 0, jwksRequests = 0;
  return {
    setMode(value) { mode = value; },
    stats: () => ({ tokenRequests, jwksRequests }),
    issue(url) {
      const q = new URL(url).searchParams;
      assert.equal(q.get('client_id'), 'google-fixture');
      assert.equal(q.get('code_challenge_method'), 'S256');
      assert.ok(q.get('nonce')); assert.ok(q.get('state'));
      const code = randomBytes(24).toString('hex'); codes.set(code, q);
      const redirect = new URL(q.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', mode === 'state' ? 'wrong' : q.get('state'));
      return redirect.href;
    },
    async fetch(input, options) {
      const url = String(input);
      if (url === `${googleIssuer}/.well-known/openid-configuration`) return json({ issuer: googleIssuer,
        authorization_endpoint: `${googleIssuer}/o/oauth2/auth`, token_endpoint: 'https://oauth2.googleapis.com/token',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs', response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') { jwksRequests++; return json({ keys: [publicJwk] }); }
      assert.equal(url, 'https://oauth2.googleapis.com/token', 'No unexpected upstream requests');
      tokenRequests++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_secret'), 'offline-fixture-secret');
      assert.equal(form.get('client_id'), 'google-fixture');
      const request = codes.get(form.get('code')); codes.delete(form.get('code'));
      assert.ok(request, 'Code must exist and be unused');
      assert.equal(form.get('redirect_uri'), request.get('redirect_uri'));
      assert.equal(hash(form.get('code_verifier')), request.get('code_challenge'), 'Upstream PKCE verifier must match');
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: mode === 'issuer' ? 'https://wrong.example' : googleIssuer,
        aud: mode === 'audience' ? 'wrong-client' : 'google-fixture', sub: mode === 'subject' ? 'unapproved-user' : 'allowed-google-sub',
        nonce: mode === 'nonce' ? 'wrong' : request.get('nonce'), iat: now, exp: mode === 'expired' ? now - 3600 : now + 300 };
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'google-mock' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const body = `${header}.${payload}`;
      let signature = sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url');
      if (mode === 'signature') signature = randomBytes(256).toString('base64url');
      return json({ access_token: 'unused-upstream-fixture', token_type: 'Bearer', expires_in: 300, id_token: `${body}.${signature}` });
    }
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nymrel-google-'));
  const google = googleMock();
  let app;
  let clock = 0;
  const server = createServer((req, res) => app.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const config = { issuer, clientId: 'chatgpt-fixture', callback,
    identity: { issuer: googleIssuer, subject: 'allowed-google-sub', accountId: 'internal-operator' },
    jwks: { keys: [{ ...key, alg: 'RS256', kid: 'issuer-fixture', use: 'sig' }] },
    cookieKeys: [randomBytes(32).toString('hex')], databasePath: join(dir, 'state.sqlite'), offline: true,
    google: { clientId: 'google-fixture', clientSecret: 'offline-fixture-secret' } };
  app = await createIssuerHttp(config, { googleFetch: google.fetch, rateLimitClock: () => clock });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); await rm(dir, { recursive: true, force: true }); });
  function browser() {
    const cookies = new Map();
    async function request(url, options = {}) {
      const target = new URL(url, issuer);
      assert.equal(target.origin, issuer, 'Tests must never send browser requests outside loopback');
      const response = await fetch(target, { redirect: 'manual', ...options, headers: {
        cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(options.headers || {}) } });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1));
      }
      return { status: response.status, location: response.headers.get('location'), body: await response.text(), headers: response.headers };
    }
    async function page(url) {
      let response;
      for (let i = 0; i < 10; i++) {
        response = await request(url);
        if (!response.location) return response;
        url = new URL(response.location, issuer).href;
      }
      throw new Error('redirect limit');
    }
    const post = (page, overrides = {}) => request(page.body.match(/action="([^"]+)"/)[1], {
      method: 'POST', headers: { origin: issuer, 'content-type': 'application/x-www-form-urlencoded', ...(overrides.headers || {}) },
      body: new URLSearchParams({ csrf: page.body.match(/name="csrf" value="([^"]+)"/)[1], ...(overrides.body || {}) }) });
    async function loginPage() {
      const verifier = randomBytes(32).toString('base64url');
      const q = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, response_type: 'code',
        scope: `openid offline_access ${READ_SCOPES}`, resource: RESOURCE, prompt: 'consent', state: 'chatgpt-state',
        code_challenge: hash(verifier), code_challenge_method: 'S256' });
      return { ...(await page(`/auth?${q}`)), verifier };
    }
    async function reachConsent() {
      const login = await loginPage();
      const start = await post(login); assert.equal(start.status, 303);
      const googleCallback = google.issue(start.location);
      const complete = await request(googleCallback); assert.equal(complete.status, 303, complete.body);
      const consent = await page(complete.location); assert.equal(consent.status, 200);
      return { ...consent, verifier: login.verifier, googleCallback };
    }
    return { request, page, post, loginPage, reachConsent, cookies };
  }
  return { browser, issuer, google, advance: ms => { clock += ms; } };
}

test('Google code verification, server-bound login and explicit consent produce downstream OAuth code', async t => {
  const f = await fixture(t), b = f.browser();
  const consent = await b.reachConsent();
  assert.match(consent.body, /Approve read-only access/);
  assert.equal(consent.headers.get('cache-control'), 'no-store');
  assert.equal((await b.request(consent.googleCallback)).status, 403, 'Google callback is one use');
  const approve = await b.post(consent); assert.equal(approve.status, 303);
  const resumed = await b.request(approve.location); assert.equal(resumed.status, 303);
  const authorized = new URL(resumed.location);
  assert.equal(authorized.origin + authorized.pathname, callback);
  assert.equal(authorized.searchParams.get('iss'), f.issuer);
  assert.equal(authorized.searchParams.get('state'), 'chatgpt-state');
  const exchange = () => b.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'chatgpt-fixture', redirect_uri: callback,
      code: authorized.searchParams.get('code'), code_verifier: consent.verifier, resource: RESOURCE }) });
  for (let i = 0; i < ISSUER_RATE_LIMITS.token; i++) {
    assert.notEqual((await b.request('/token', { method: 'POST' })).status, 429);
  }
  assert.equal((await exchange()).status, 429, 'Throttled token exchange must not consume the code');
  for (const path of ['/TOKEN', '/ToKeN', '/token/revocation', '/TOKEN/REVOCATION', '/ToKeN/ReVoCaTiOn']) {
    const blocked = await b.request(path, { method: 'POST' });
    assert.equal(blocked.status, 429, `${path} must share the exhausted token budget`);
    assert.equal(blocked.headers.get('retry-after'), '1');
  }
  f.advance(1000);
  const token = await exchange();
  assert.equal(token.status, 200, token.body);
  const payload = JSON.parse(Buffer.from(JSON.parse(token.body).access_token.split('.')[1], 'base64url'));
  assert.equal(payload.sub, 'internal-operator'); assert.equal(payload.aud, RESOURCE);
  assert.equal(f.google.stats().tokenRequests, 1); assert.equal(f.google.stats().jwksRequests, 1);
  assert.equal((await b.post(consent)).status, 403, 'Consent cannot be replayed');
});

test('Google callback budget blocks upstream work without consuming pending valid login', async t => {
  const f = await fixture(t), b = f.browser();
  const start = await b.post(await b.loginPage());
  const valid = f.google.issue(start.location);
  const results = await Promise.all(Array.from({ length: ISSUER_RATE_LIMITS.google + 5 }, (_, i) =>
    b.request(`/google/callback?state=wrong-${i}`, { headers: { 'x-forwarded-for': `192.0.2.${i}`, forwarded: `for=192.0.2.${i}` } })));
  assert.equal(results.filter(r => r.status === 403).length, ISSUER_RATE_LIMITS.google);
  assert.equal(results.filter(r => r.status === 429).length, 5);
  const blocked = await b.request(valid);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '3');
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.equal(blocked.headers.get('set-cookie'), null);
  assert.equal(f.google.stats().tokenRequests, 0);
  assert.equal((await b.request('/.well-known/openid-configuration')).status, 200);
  f.advance(3000);
  const completed = await b.request(valid);
  assert.equal(completed.status, 303, completed.body);
  assert.equal(f.google.stats().tokenRequests, 1);
  assert.equal((await b.page(completed.location)).status, 200);
});

test('interaction attempts share a budget across paths, methods, cookies and forwarding headers', async t => {
  const f = await fixture(t), b = f.browser();
  for (let i = 0; i < ISSUER_RATE_LIMITS.interaction; i++) {
    const result = await b.request(`/interaction/fake-${i}/start`, { method: 'POST',
      headers: { cookie: `nymrel_interaction=${randomBytes(32).toString('base64url')}`, 'x-forwarded-for': `192.0.2.${i}` } });
    assert.equal(result.status, 403);
  }
  const blocked = await b.request('/auth');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  assert.equal(blocked.headers.get('set-cookie'), null);
  assert.equal(f.google.stats().tokenRequests, 0);
  f.advance(60000);
  assert.equal((await b.reachConsent()).status, 200);
});

test('Google state, nonce, signature, audience, issuer, expiry and subject failures deny login', async t => {
  for (const mode of ['state', 'nonce', 'signature', 'audience', 'issuer', 'expired', 'subject']) {
    await t.test(mode, async t => {
      const f = await fixture(t), b = f.browser(); f.google.setMode(mode);
      const start = await b.post(await b.loginPage());
      const result = await b.request(f.google.issue(start.location));
      assert.equal(result.status, 403, mode); assert.equal(result.location, null);
      if (mode === 'state') assert.equal(f.google.stats().tokenRequests, 0);
    });
  }
});

test('CSRF, origin, identity injection, altered cookie and cross-browser/interaction substitution fail', async t => {
  const f = await fixture(t), b = f.browser();
  const login = await b.loginPage();
  assert.equal((await b.post(login, { body: { csrf: 'wrong' } })).status, 403);
  assert.equal((await b.post(login, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await b.post(login, { body: { subject: 'allowed-google-sub' } })).status, 403);
  const stranger = f.browser();
  assert.equal((await stranger.post(login)).status, 403);
  const second = await b.loginPage();
  assert.equal((await b.post(login)).status, 403, 'Another interaction cannot replace the original');
  const originalCookie = b.cookies.get('nymrel_interaction');
  b.cookies.set('nymrel_interaction', randomBytes(32).toString('base64url'));
  assert.equal((await b.post(second)).status, 403);
  b.cookies.set('nymrel_interaction', originalCookie);
  const consent = await b.reachConsent();
  assert.equal((await b.post(consent, { body: { csrf: 'wrong' } })).status, 403);
  assert.equal((await b.post(consent, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await stranger.post(consent)).status, 403);
});

test('verified Google callback stays bound to original provider interaction; concurrent consent is one use', async t => {
  const f = await fixture(t), original = f.browser(), other = f.browser();
  const start = await original.post(await original.loginPage());
  const googleCallback = f.google.issue(start.location);
  const callbacks = await Promise.all([original.request(googleCallback), original.request(googleCallback)]);
  assert.deepEqual(callbacks.map(r => r.status).sort(), [303, 403]);
  const finish = callbacks.find(r => r.status === 303).location;
  await other.loginPage();
  other.cookies.set('nymrel_interaction', original.cookies.get('nymrel_interaction'));
  assert.equal((await other.request(finish)).status, 403, 'Binding cookie alone cannot substitute provider interaction');
  const consent = await original.page(finish);
  assert.equal(consent.status, 200, consent.body);
  const approvals = await Promise.all([original.post(consent), original.post(consent)]);
  assert.deepEqual(approvals.map(r => r.status).sort(), [303, 403]);
});

test('unsolicited wrong or duplicate state callbacks do not consume pending legitimate Google login', async t => {
  const f = await fixture(t), b = f.browser();
  const start = await b.post(await b.loginPage());
  const valid = new URL(f.google.issue(start.location));
  const wrong = new URL(valid); wrong.searchParams.set('state', 'unsolicited');
  assert.equal((await b.request(wrong)).status, 403);
  const duplicate = new URL(valid); duplicate.searchParams.append('state', valid.searchParams.get('state'));
  assert.equal((await b.request(duplicate)).status, 403);
  assert.equal(f.google.stats().tokenRequests, 0);
  const callbackResult = await b.request(valid);
  assert.equal(callbackResult.status, 303, 'Legitimate pending callback must still succeed');
  assert.equal((await b.page(callbackResult.location)).status, 200);
  assert.equal(f.google.stats().tokenRequests, 1);
});
