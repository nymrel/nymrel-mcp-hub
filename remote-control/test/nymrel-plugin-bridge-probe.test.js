import assert from 'node:assert/strict';
import test from 'node:test';
import { checkNymrelPluginBridge } from '../scripts/check-nymrel-plugin-bridge.mjs';

const metadata = 'https://mcp.nymrel.com/.well-known/oauth-protected-resource/mcp';
const issuer = 'https://auth.example.com/';
const resource = 'https://mcp.nymrel.com/mcp';
const challenge = `Bearer scope="devices:read tools:read", resource_metadata="${metadata}"`;

function fixture({ backendEnabled = true, backendScopes = ['devices:read', 'tools:read'], challengeValue = challenge, issuerValue = issuer } = {}) {
  return async (url, init = {}) => {
    if (url === metadata) return Response.json({ resource, authorization_servers: [issuerValue], scopes_supported: ['devices:read', 'tools:read'] });
    if (url.includes('/.well-known/oauth-protected-resource/nymrel/plugin/readonly/mcp')) {
      return backendEnabled ? Response.json({ resource, authorization_servers: [issuerValue], scopes_supported: backendScopes }) : Response.json({}, { status: 404 });
    }
    if (url.endsWith('/nymrel/plugin/readonly/mcp') && init.method === 'POST') {
      return backendEnabled ? Response.json({}, { status: 401, headers: { 'www-authenticate': challengeValue } }) : Response.json({}, { status: 404 });
    }
    throw new Error(`Unexpected preflight URL: ${url}`);
  };
}

test('reports the current closed route distinctly without claiming ChatGPT access', async () => {
  const result = await checkNymrelPluginBridge({ fetchImpl: fixture({ backendEnabled: false }) });
  assert.equal(result.status, 'backend_disabled');
  assert.deepEqual(result.failures, ['backend_resource_metadata', 'backend_anonymous_challenge', 'backend_rejects_invalid_bearer']);
  assert.equal(result.authenticatedChatgptRead, 'not_validated');
});

test('an open bridge is only ready for a real login and file-read test', async () => {
  const result = await checkNymrelPluginBridge({ fetchImpl: fixture() });
  assert.equal(result.status, 'ready_for_login_test');
  assert.deepEqual(result.failures, []);
  assert.equal(result.authenticatedChatgptRead, 'not_validated');
});

test('extra scopes or a private metadata challenge cannot pass the public resource boundary', async () => {
  const wide = await checkNymrelPluginBridge({ fetchImpl: fixture({ backendScopes: ['devices:read', 'tools:read', 'tools:execute'] }) });
  assert.ok(wide.failures.includes('backend_resource_metadata'));
  const privateChallenge = await checkNymrelPluginBridge({ fetchImpl: fixture({ challengeValue: 'Bearer scope="devices:read tools:read", resource_metadata="https://other.example.com"' }) });
  assert.ok(privateChallenge.failures.includes('backend_anonymous_challenge'));
});

test('malformed or duplicate OAuth challenge parameters cannot pass', async () => {
  for (const challengeValue of [
    `Bearer scope="devices:read tools:read", xresource_metadata="${metadata}"`,
    `Bearer scope="devices:read tools:read", resource_metadata="https://wrong.example.com", resource_metadata="${metadata}"`,
    `Bearer scope="devices:read tools:read", resource_metadata="${metadata}", resource_metadata="https://wrong.example.com"`,
    `Bearer scope="devices:read tools:read", resource_metadata="${metadata}", invalid`
  ]) {
    const result = await checkNymrelPluginBridge({ fetchImpl: fixture({ challengeValue }) });
    assert.ok(result.failures.includes('backend_anonymous_challenge'), challengeValue);
  }
});

test('invalid issuer identifiers and endpoint redirects cannot pass', async () => {
  for (const issuerValue of ['https://', 'https://user:pass@auth.example.com/', 'https://auth.example.com/?bad=1',
    ' https://auth.example.com/ ', 'https:auth.example.com', 'https://auth.example.com/a/../b',
    'https://auth.example.com/\\path']) {
    const result = await checkNymrelPluginBridge({ fetchImpl: fixture({ issuerValue }) });
    assert.ok(result.failures.includes('public_resource_metadata'), issuerValue);
  }
  for (const status of [301, 302, 307, 308]) {
    const normal = fixture();
    const seen = [];
    const redirected = async (url, init) => {
      seen.push(init?.redirect);
      if (url.includes('/.well-known/oauth-protected-resource/nymrel/plugin/readonly/mcp')) {
        return new Response(null, { status, headers: { location: 'https://elsewhere.example.com/metadata' } });
      }
      return normal(url, init);
    };
    const result = await checkNymrelPluginBridge({ fetchImpl: redirected });
    assert.ok(result.failures.includes('backend_resource_metadata'), String(status));
    assert.ok(seen.every((value) => value === 'manual'));
  }
});
