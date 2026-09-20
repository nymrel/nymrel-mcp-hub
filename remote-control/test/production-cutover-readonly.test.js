import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProductionCutover, REQUIRED_CHATGPT_READONLY_SCOPES } from '../scripts/check-production-cutover.mjs';
import { createChatgptRemoteHttpServer } from '../src/chatgpt-server.js';

const BASE = 'https://remote.example.com';
const AUTH = 'https://auth.example.com';
const RESOURCE_PATH = '/chatgpt/readonly/mcp';
const METADATA_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
const SCRIPT = fileURLToPath(new URL('../scripts/check-production-cutover.mjs', import.meta.url));

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function authorizationServerMetadata(issuer = AUTH) {
  return json({
    issuer,
    authorization_endpoint: `${AUTH}/oauth/authorize`,
    token_endpoint: `${AUTH}/oauth/token`,
    jwks_uri: `${AUTH}/.well-known/jwks.json`,
    scopes_supported: ['openid', 'offline_access'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true
  });
}

function readonlyFetch({
  authorizationServers = [AUTH],
  scopes = [...REQUIRED_CHATGPT_READONLY_SCOPES],
  resource = `${BASE}${RESOURCE_PATH}`,
  challenge = `Bearer scope="devices:read tools:read", resource_metadata="${BASE}${METADATA_PATH}"`,
  invalidBearerStatus = 401
} = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === AUTH && parsed.pathname === '/.well-known/oauth-authorization-server') return authorizationServerMetadata();
    if (parsed.origin !== BASE) return json({ error: 'not found' }, 404);
    if (parsed.pathname === '/healthz') return json({ status: 'ok' });
    if (parsed.pathname === '/readyz') return json({ status: 'ready', audit: { valid: true } });
    if (['/privacy', '/terms', '/support'].includes(parsed.pathname)) {
      return new Response('<!doctype html><title>Nymrel Remote</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (parsed.pathname === METADATA_PATH) {
      return json({ resource, authorization_servers: authorizationServers, scopes_supported: scopes, bearer_methods_supported: ['header'] });
    }
    if (parsed.pathname === RESOURCE_PATH && init.method === 'POST') {
      if (init.headers?.authorization) return json({ error: { code: 'UNAUTHORIZED' } }, invalidBearerStatus, { 'www-authenticate': challenge });
      return json({ error: { code: 'UNAUTHORIZED' } }, 401, { 'www-authenticate': challenge });
    }
    return json({ error: 'not found' }, 404);
  };
}

test('read-only cutover profile is ready only for the exact read-only resource, scopes, and challenge', async () => {
  const result = await checkProductionCutover(BASE, { fetchImpl: readonlyFetch(), profile: 'readonly' });
  assert.equal(result.status, 'ready');
  assert.equal(result.profile, 'readonly');
  assert.deepEqual(result.failures, []);
  assert.ok(result.checks.some((item) => item.name === 'read-only resource rejects an unverifiable bearer' && item.passed));
});

test('read-only cutover profile blocks a resource that advertises or challenges for more than the read scopes', async () => {
  let result = await checkProductionCutover(BASE, {
    fetchImpl: readonlyFetch({ scopes: ['devices:read', 'tools:read', 'tools:write'] }), profile: 'readonly'
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.checks.find((item) => item.name === 'chatgpt protected-resource metadata').detail.unexpectedScopes, ['tools:write']);

  result = await checkProductionCutover(BASE, { fetchImpl: readonlyFetch({ scopes: ['devices:read'] }), profile: 'readonly' });
  assert.deepEqual(result.checks.find((item) => item.name === 'chatgpt protected-resource metadata').detail.missingScopes, ['tools:read']);

  result = await checkProductionCutover(BASE, {
    fetchImpl: readonlyFetch({ challenge: `Bearer scope="devices:read tools:read tools:execute", resource_metadata="${BASE}${METADATA_PATH}"` }),
    profile: 'readonly'
  });
  assert.deepEqual(result.failures, ['unauthenticated ChatGPT MCP challenge']);
});

test('read-only cutover profile blocks the wrong resource, a full-catalog challenge, or an accepted unverifiable bearer', async () => {
  let result = await checkProductionCutover(BASE, { fetchImpl: readonlyFetch({ resource: `${BASE}/chatgpt/mcp` }), profile: 'readonly' });
  assert.ok(result.failures.includes('chatgpt protected-resource metadata'));

  result = await checkProductionCutover(BASE, {
    fetchImpl: readonlyFetch({ challenge: `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/chatgpt/mcp"` }),
    profile: 'readonly'
  });
  assert.ok(result.failures.includes('unauthenticated ChatGPT MCP challenge'));

  result = await checkProductionCutover(BASE, { fetchImpl: readonlyFetch({ invalidBearerStatus: 200 }), profile: 'readonly' });
  assert.deepEqual(result.failures, ['read-only resource rejects an unverifiable bearer']);
});

test('read-only cutover profile is OAuth-only and can never be probed in static-auth compatibility mode', async () => {
  const result = await checkProductionCutover(BASE, { fetchImpl: readonlyFetch({ authorizationServers: [] }), profile: 'readonly' });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('chatgpt protected-resource metadata'));

  await assert.rejects(checkProductionCutover(BASE, { fetchImpl: readonlyFetch(), profile: 'readonly', requireOAuth: false }), /OAuth-only/);
  await assert.rejects(checkProductionCutover(BASE, { fetchImpl: readonlyFetch(), profile: 'constructor' }), /Unknown cutover profile/);

  for (const args of [['--profile=readonly', '--allow-static-auth'], ['--profile=unknown']]) {
    const cli = spawnSync(process.execPath, [SCRIPT, BASE, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 2, args.join(' '));
    assert.match(cli.stderr, /--profile=full\|readonly/);
    assert.equal(cli.stdout, '');
  }
});

test('the read-only cutover profile passes against the real server wiring and blocks when no authorization server is configured', async (t) => {
  const key = Buffer.alloc(32, 43);
  for (const [authorizationServers, expected] of [[[AUTH], 'ready'], [[], 'blocked']]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-cutover-readonly-'));
    const config = {
      production: false, host: '127.0.0.1', port: 0, publicBaseUrl: BASE,
      storePath: path.join(dir, 'state.json'), signingKey: key, dataKey: key, auditKey: key,
      bootstrapToken: 'bootstrap-test-token-not-for-production', callTtlMs: 60_000, callRetentionMs: 86_400_000, syncWaitMs: 0,
      heartbeatTtlMs: 60_000, pairingTtlMs: 60_000, pairingRetentionMs: 3_600_000, maxBodyBytes: 1024 * 1024,
      maxToolSchemaBytes: 65536, maxToolsPerDevice: 64, allowedOrigins: [], authorizationServers,
      allowStaticMcpTokens: true, allowStaticAdminTokens: true, allowBootstrapHttp: true,
      oauthIssuer: AUTH, oauthJwksUrl: null, oauthAudience: null, oauthTenantClaim: 'tenant',
      oauthSubjectTenants: new Map([['auth0|operator', 'default']]),
      oauthIntrospectionUrl: null, oauthIntrospectionClientId: null, oauthIntrospectionClientSecret: null
    };
    const { server } = await createChatgptRemoteHttpServer(config, {
      logger: { info() {}, error() {} },
      oauthFetchImpl: async () => json({ error: 'not found' }, 404)
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    });
    const local = `http://127.0.0.1:${server.address().port}`;
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.origin === AUTH) {
        return parsed.pathname === '/.well-known/oauth-authorization-server' ? authorizationServerMetadata() : json({ error: 'not found' }, 404);
      }
      return fetch(`${local}${parsed.pathname}`, init);
    };

    const result = await checkProductionCutover(BASE, { fetchImpl, profile: 'readonly' });
    assert.equal(result.status, expected, JSON.stringify(result.failures));
    if (expected === 'blocked') assert.deepEqual(result.failures, ['chatgpt protected-resource metadata']);

    const full = await checkProductionCutover(BASE, { fetchImpl });
    assert.equal(full.status, expected, 'the full-profile probe is unchanged');
  }
});
