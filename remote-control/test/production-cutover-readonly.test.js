import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  authMetadata = {},
  invalidBearerStatus = 401
} = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === AUTH && parsed.pathname === '/.well-known/oauth-authorization-server') return json({ ...await authorizationServerMetadata().json(), ...authMetadata });
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
  const result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch(), profile: 'readonly' });
  assert.equal(result.status, 'ready');
  assert.equal(result.profile, 'readonly');
  assert.deepEqual(result.failures, []);
  assert.ok(result.checks.some((item) => item.name === 'read-only resource rejects an unverifiable bearer' && item.passed));
});

test('read-only cutover profile blocks a resource that advertises or challenges for more than the read scopes', async () => {
  let result = await checkProductionCutover(BASE, { hasPredefinedClient: true,
    fetchImpl: readonlyFetch({ scopes: ['devices:read', 'tools:read', 'tools:write'] }), profile: 'readonly'
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.checks.find((item) => item.name === 'chatgpt protected-resource metadata').detail.unexpectedScopes, ['tools:write']);

  result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch({ scopes: ['devices:read'] }), profile: 'readonly' });
  assert.deepEqual(result.checks.find((item) => item.name === 'chatgpt protected-resource metadata').detail.missingScopes, ['tools:read']);

  result = await checkProductionCutover(BASE, { hasPredefinedClient: true,
    fetchImpl: readonlyFetch({ challenge: `Bearer scope="devices:read tools:read tools:execute", resource_metadata="${BASE}${METADATA_PATH}"` }),
    profile: 'readonly'
  });
  assert.deepEqual(result.failures, ['unauthenticated ChatGPT MCP challenge']);
});

test('read-only cutover profile blocks the wrong resource, a full-catalog challenge, or an accepted unverifiable bearer', async () => {
  let result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch({ resource: `${BASE}/chatgpt/mcp` }), profile: 'readonly' });
  assert.ok(result.failures.includes('chatgpt protected-resource metadata'));

  result = await checkProductionCutover(BASE, { hasPredefinedClient: true,
    fetchImpl: readonlyFetch({ challenge: `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/chatgpt/mcp"` }),
    profile: 'readonly'
  });
  assert.ok(result.failures.includes('unauthenticated ChatGPT MCP challenge'));

  result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch({ invalidBearerStatus: 200 }), profile: 'readonly' });
  assert.deepEqual(result.failures, ['read-only resource rejects an unverifiable bearer']);
});

test('read-only cutover profile is OAuth-only and can never be probed in static-auth compatibility mode', async () => {
  const result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch({ authorizationServers: [] }), profile: 'readonly' });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('chatgpt protected-resource metadata'));

  await assert.rejects(checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch(), profile: 'readonly', requireOAuth: false }), /OAuth-only/);
  await assert.rejects(checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl: readonlyFetch(), profile: 'constructor' }), /Unknown cutover profile/);

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

    const result = await checkProductionCutover(BASE, { hasPredefinedClient: true, fetchImpl, profile: 'readonly' });
    assert.equal(result.status, expected, JSON.stringify(result.failures));
    if (expected === 'blocked') assert.deepEqual(result.failures, ['chatgpt protected-resource metadata']);

    const full = await checkProductionCutover(BASE, { fetchImpl });
    assert.equal(full.status, expected, 'the full-profile probe is unchanged');
  }
});


test('Auth0-style advertised registration with tenant DCR disabled cannot prove readonly onboarding', async () => {
  // Auth0 discovery can publish this endpoint even when tenant DCR is disabled.
  // The public probe cannot observe that policy and must never attempt registration.
  const authMetadata = { client_id_metadata_document_supported: false, registration_endpoint: AUTH + '/oidc/register' };
  let registrations = 0;
  const discovery = readonlyFetch({ authMetadata });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/oidc/register')) { registrations++; return json({}, 403); }
    return discovery(url, init);
  };
  const blocked = await checkProductionCutover(BASE, { profile: 'readonly', fetchImpl });
  assert.deepEqual(blocked.failures, ['authorization-server metadata']);
  assert.equal(blocked.checks.find(c => c.name === 'authorization-server metadata').detail.clientOnboarding.evidence, 'metadata-only');
  assert.equal(registrations, 0);
  const ready = await checkProductionCutover(BASE, { profile: 'readonly', fetchImpl, hasPredefinedClient: true });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.checks.find(c => c.name === 'authorization-server metadata').detail.clientOnboarding.selected, 'predefined');
});

test('readonly dynamic onboarding requires explicit verification and matching discovery capability', async () => {
  for (const method of ['cimd', 'dcr']) {
    const authMetadata = { client_id_metadata_document_supported: method === 'cimd',
      registration_endpoint: method === 'dcr' ? AUTH + '/register' : null };
    const options = { profile: 'readonly', fetchImpl: readonlyFetch({ authMetadata }) };
    assert.equal((await checkProductionCutover(BASE, options)).status, 'blocked');
    const verified = await checkProductionCutover(BASE, { ...options, verifiedDynamicClient: method });
    assert.equal(verified.status, 'ready');
    assert.equal(verified.checks.find(c => c.name === 'authorization-server metadata').detail.clientOnboarding.evidence, 'operator-attested');
    assert.equal((await checkProductionCutover(BASE, { ...options, verifiedDynamicClient: method === 'cimd' ? 'dcr' : 'cimd' })).status, 'blocked');
  }
  await assert.rejects(checkProductionCutover(BASE, { profile: 'readonly', verifiedDynamicClient: 'auto' }), /must be cimd or dcr/);
  await assert.rejects(checkProductionCutover(BASE, { profile: 'readonly', hasPredefinedClient: true, verifiedDynamicClient: 'dcr' }), /only one/);
  for (const args of [['--verified-dynamic-client=auto'], ['--predefined-client', '--verified-dynamic-client=dcr']]) {
    const cli = spawnSync(process.execPath, [SCRIPT, BASE, '--profile=readonly', ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.equal(cli.stdout, '');
  }
});


test('CLI forwards verified dynamic client selection to the strict readonly check', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-onboarding-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'fetch-fixture.mjs');
  await fs.writeFile(shim, [
    'const BASE = ' + JSON.stringify(BASE) + ';',
    'const AUTH = ' + JSON.stringify(AUTH) + ';',
    'const RESOURCE_PATH = ' + JSON.stringify(RESOURCE_PATH) + ';',
    'const METADATA_PATH = ' + JSON.stringify(METADATA_PATH) + ';',
    'const REQUIRED_CHATGPT_READONLY_SCOPES = ' + JSON.stringify(REQUIRED_CHATGPT_READONLY_SCOPES) + ';',
    json.toString(), authorizationServerMetadata.toString(), readonlyFetch.toString(),
    'globalThis.fetch = readonlyFetch({ authMetadata: { registration_endpoint: AUTH + "/register" } });'
  ].join('\n'));
  for (const [args, expected] of [[[], 1], [['--verified-dynamic-client=cimd'], 0], [['--verified-dynamic-client=dcr'], 0], [['--predefined-client'], 0]]) {
    const cli = spawnSync(process.execPath, ['--import', pathToFileURL(shim).href, SCRIPT, BASE, '--profile=readonly', ...args], { encoding: 'utf8' });
    assert.equal(cli.status, expected, cli.stderr + cli.stdout);
    assert.ok(cli.stdout, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, expected === 0 ? 'ready' : 'blocked');
  }
});
