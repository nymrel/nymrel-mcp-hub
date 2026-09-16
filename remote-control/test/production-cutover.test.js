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

function healthyFetch({ authorizationServers = ['https://auth.example.com'], challengeMetadata = METADATA } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/healthz') return json({ status: 'ok' });
    if (parsed.pathname === '/readyz') return json({ status: 'ready', audit: { valid: true } });
    if (parsed.pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp') {
      return json({
        resource: `${BASE}/chatgpt/mcp`,
        authorization_servers: authorizationServers,
        scopes_supported: [...REQUIRED_CHATGPT_SCOPES],
        bearer_methods_supported: ['header']
      });
    }
    if (['/privacy', '/terms', '/support'].includes(parsed.pathname)) return html();
    if (parsed.pathname === '/chatgpt/mcp' && init.method === 'POST') {
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
