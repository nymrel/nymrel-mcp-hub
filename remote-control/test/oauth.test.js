import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuthAccessTokenVerifier, joseEcdsaToDer } from '../src/oauth.js';

function enc(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function jwt(privateKey, alg, payload, options = {}) {
  const header = { alg, typ: 'JWT', kid: 'k1' };
  const input = `${enc(header)}.${enc(payload)}`;
  const algorithm = alg === 'RS256' ? 'sha256' : 'sha256';
  const signature = sign(algorithm, Buffer.from(input), alg.startsWith('ES')
    ? { key: privateKey, dsaEncoding: 'ieee-p1363' }
    : privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('OAuth verifier validates audience-bound RS256 access tokens', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'k1'; jwk.alg = 'RS256';
  const now = 1_800_000_000_000;
  const verifier = new OAuthAccessTokenVerifier({
    issuer: 'https://issuer.example', jwksUrl: 'https://issuer.example/jwks', audience: 'https://remote.example/mcp',
    fetchImpl: async (url) => { assert.equal(String(url), 'https://issuer.example/jwks'); return jsonResponse({ keys: [jwk] }); }
  });
  const token = jwt(privateKey, 'RS256', {
    iss: 'https://issuer.example', sub: 'user-1', aud: 'https://remote.example/mcp', exp: Math.floor(now / 1000) + 600,
    scope: 'tools:read calls:read', tenant: 'tenant-a'
  });
  const principal = await verifier.verify(token, now);
  assert.equal(principal.sub, 'user-1');
  assert.deepEqual(principal.scopes, ['tools:read', 'calls:read']);
  assert.equal(principal.tenant, 'tenant-a');

  const wrongAud = jwt(privateKey, 'RS256', {
    iss: 'https://issuer.example', sub: 'user-1', aud: 'https://other.example', exp: Math.floor(now / 1000) + 600
  });
  await assert.rejects(verifier.verify(wrongAud, now), /audience mismatch/);
});

test('OAuth verifier converts JOSE P-1363 ES256 signatures to DER for Node crypto verification', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'k1'; jwk.alg = 'ES256';
  const now = 1_800_000_000_000;
  const token = jwt(privateKey, 'ES256', {
    iss: 'https://issuer.example', sub: 'ec-user', aud: 'https://remote.example/mcp', exp: Math.floor(now / 1000) + 600
  });
  const raw = Buffer.from(token.split('.')[2], 'base64url');
  const der = joseEcdsaToDer(raw, 'ES256');
  assert.equal(der[0], 0x30);
  const verifier = new OAuthAccessTokenVerifier({
    issuer: 'https://issuer.example', jwksUrl: 'https://issuer.example/jwks', audience: 'https://remote.example/mcp',
    fetchImpl: async () => jsonResponse({ keys: [jwk] })
  });
  const principal = await verifier.verify(token, now);
  assert.equal(principal.sub, 'ec-user');
});

test('opaque access tokens are accepted only when introspection is active and audience-bound', async () => {
  const verifier = new OAuthAccessTokenVerifier({
    introspectionUrl: 'https://issuer.example/introspect', audience: 'https://remote.example/mcp',
    introspectionClientId: 'client', introspectionClientSecret: 'secret',
    fetchImpl: async (_url, init) => {
      assert.match(init.headers.authorization, /^Basic /);
      return jsonResponse({ active: true, sub: 'opaque-user', aud: 'https://remote.example/mcp', scope: 'tools:read', exp: Math.floor(Date.now() / 1000) + 60 });
    }
  });
  const principal = await verifier.verify('opaque-token-value');
  assert.equal(principal.sub, 'opaque-user');
  assert.deepEqual(principal.scopes, ['tools:read']);
});
