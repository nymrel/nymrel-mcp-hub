import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProductionCutover, REQUIRED_CHATGPT_SCOPES } from '../scripts/check-production-cutover.mjs';

const BASE = 'https://remote.example.com';
const METADATA = `${BASE}/.well-known/oauth-protected-resource/chatgpt/mcp`;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function html(status = 200) {
  return new Response('<!doctype html><title>Nymrel Remote</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

function healthyFetch({
  authorizationServers = ['https://auth.example.com'],
  challengeMetadata = METADATA,
  authScopes = [...REQUIRED_CHATGPT_SCOPES, 'offline_access'],
  codeChallengeMethods = ['S256'],
  authIssuer = 'https://auth.example.com',
  tokenEndpointAuthMethods = ['none'],
  clientIdMetadataSupported = true,
  registrationEndpoint = null
} = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'remote.example.com' && parsed.pathname === '/healthz') return json({ status: 'ok' });
    if (parsed.hostname === 'remote.example.com' && parsed.pathname === '/readyz') return json({ status: 'ready', audit: { valid: true } });
    if (parsed.hostname === 'remote.example.com' && parsed.pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp') {
      return json({
        resource: `${BASE}/chatgpt/mcp`,
        authorization_servers: authorizationServers,
        scopes_supported: [...REQUIRED_CHATGPT_SCOPES],
        bearer_methods_supported: ['header']
      });
    }
    if (parsed.hostname === 'auth.example.com' && parsed.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: authIssuer,
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
        scopes_supported: authScopes,
        code_challenge_methods_supported: codeChallengeMethods,
        token_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
        client_id_metadata_document_supported: clientIdMetadataSupported,
        registration_endpoint: registrationEndpoint
      });
    }
    if (parsed.hostname === 'remote.example.com' && ['/privacy', '/terms', '/support'].includes(parsed.pathname)) return html();
    if (parsed.hostname === 'remote.example.com' && parsed.pathname === '/chatgpt/mcp' && init.method === 'POST') {
      return json(
        { error: { code: 'UNAUTHORIZED', message: 'OAuth bearer token required' } },
        401,
        { 'www-authenticate': `Bearer resource_metadata="${challengeMetadata}"` }
      );
    }
    return json({ error: 'not found' }, 404);
  };
}

test('production cutover is ready when health, audit, OAuth metadata, public pages, and MCP challenge are valid', async () => {
  const result = await checkProductionCutover(BASE, { fetchImpl: healthyFetch() });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.failures, []);
});

test('production cutover blocks a static-token-only ChatGPT endpoint by default', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ authorizationServers: [] })
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('chatgpt protected-resource metadata'));
  const metadata = result.checks.find((item) => item.name === 'chatgpt protected-resource metadata');
  assert.equal(metadata.detail.authorizationServerCount, 0);
  assert.equal(metadata.detail.requireOAuth, true);
});

test('production cutover blocks an authorization server that does not advertise all resource scopes', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ authScopes: ['offline_access', 'devices:read', 'tools:read'] })
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('authorization-server metadata'));
  const metadata = result.checks.find((item) => item.name === 'authorization-server metadata');
  assert.deepEqual(metadata.detail.missingScopes, ['tools:write', 'tools:execute', 'tools:network']);
});

test('production cutover requires PKCE S256 from the authorization server', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ codeChallengeMethods: ['plain'] })
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('authorization-server metadata'));
  const metadata = result.checks.find((item) => item.name === 'authorization-server metadata');
  assert.equal(metadata.detail.supportsPkceS256, false);
});

test('production cutover blocks OAuth without a discoverable or predefined client onboarding path', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ clientIdMetadataSupported: false })
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('authorization-server metadata'));
  const metadata = result.checks.find((item) => item.name === 'authorization-server metadata');
  assert.equal(metadata.detail.clientOnboarding.ready, false);
});

test('a predefined OAuth client can satisfy onboarding when CIMD and DCR are unavailable', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ clientIdMetadataSupported: false }),
    hasPredefinedClient: true
  });
  assert.equal(result.status, 'ready');
});

test('compatibility probe can explicitly allow static auth without weakening strict default', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ authorizationServers: [] }),
    requireOAuth: false
  });
  assert.equal(result.status, 'ready');
});

test('production cutover blocks an MCP challenge that does not point back to protected-resource metadata', async () => {
  const result = await checkProductionCutover(BASE, {
    fetchImpl: healthyFetch({ challengeMetadata: 'https://wrong.example.com/metadata' })
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.failures.includes('unauthenticated ChatGPT MCP challenge'));
});

test('production cutover requires https', async () => {
  await assert.rejects(
    checkProductionCutover('http://remote.example.com', { fetchImpl: healthyFetch() }),
    /must use https/
  );
});
