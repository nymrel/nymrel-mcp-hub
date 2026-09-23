import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createChatgptRemoteHttpServer } from '../src/chatgpt-server.js';
import { CHATGPT_READONLY_TOOL_NAMES } from '../src/chatgpt-readonly-profile.js';
import { CLIENT_CAPABILITIES_META_KEY, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '../src/mcp-protocol.js';

const key = Buffer.alloc(32, 41);
const PUBLIC_URL = 'https://remote.example.test';
// The trailing slash is deliberate: issuer identifiers must be matched exactly, never normalized.
const ISSUER = 'https://issuer.example.test/';
const JWKS_URL = 'https://issuer.example.test/.well-known/jwks.json';
const INTROSPECTION_URL = 'https://issuer.example.test/oauth/introspect';
const READONLY_AUDIENCE = `${PUBLIC_URL}/chatgpt/readonly/mcp`;
const NYMREL_PLUGIN_AUDIENCE = 'https://mcp.nymrel.com/mcp';
const NYMREL_PLUGIN_ROUTE = '/nymrel/plugin/readonly/mcp';
const CHATGPT_AUDIENCE = `${PUBLIC_URL}/chatgpt/mcp`;
const MCP_AUDIENCE = `${PUBLIC_URL}/mcp`;
const OPERATOR_SUBJECT = 'auth0|operator';
const OPERATOR_TENANT = 'jalen-tenant';
const FOREIGN_TENANT = 'foreign-tenant';
const READ_SCOPE = 'devices:read tools:read';

function enc(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'k1'; jwk.alg = 'ES256';
  const jwt = (payload) => {
    const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc(payload)}`;
    const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${input}.${signature.toString('base64url')}`;
  };
  return { jwk, jwt };
}

function claims(overrides = {}) {
  return {
    iss: ISSUER, sub: OPERATOR_SUBJECT, aud: READONLY_AUDIENCE, scope: READ_SCOPE,
    exp: Math.floor(Date.now() / 1000) + 600, ...overrides
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function configFor(dir, overrides = {}) {
  return {
    production: false, host: '127.0.0.1', port: 0, publicBaseUrl: PUBLIC_URL,
    storePath: path.join(dir, 'state.json'), signingKey: key, dataKey: key, auditKey: key,
    bootstrapToken: 'bootstrap-test-token-not-for-production', callTtlMs: 60_000, callRetentionMs: 86_400_000, syncWaitMs: 0,
    heartbeatTtlMs: 60_000, pairingTtlMs: 60_000, pairingRetentionMs: 3_600_000, maxBodyBytes: 1024 * 1024,
    maxToolSchemaBytes: 65536, maxToolsPerDevice: 64, allowedOrigins: [], authorizationServers: [ISSUER],
    // Static compatibility stays enabled to prove the read-only resource ignores it.
    allowStaticMcpTokens: true, allowStaticAdminTokens: true, allowBootstrapHttp: true,
    oauthIssuer: ISSUER, oauthJwksUrl: JWKS_URL, oauthAudience: MCP_AUDIENCE, oauthTenantClaim: 'tenant',
    oauthSubjectTenants: new Map([[OPERATOR_SUBJECT, OPERATOR_TENANT]]),
    oauthIntrospectionUrl: INTROSPECTION_URL, oauthIntrospectionClientId: null, oauthIntrospectionClientSecret: null,
    ...overrides
  };
}

function modernMeta() {
  return { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} };
}

async function jsonFetch(base, route, init = {}) {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

function listTools(base, route, token) {
  return jsonFetch(base, route, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
  });
}

function callTool(base, route, token, name, args = {}) {
  return jsonFetch(base, route, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': 'tools/call', 'mcp-name': name
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args, _meta: modernMeta() } })
  });
}

async function pairDevice(runtime, tenant, deviceName) {
  const pairing = await runtime.broker.startPairing({ deviceName, platform: 'win32' });
  await runtime.broker.approvePairing({ typ: 'user', sub: 'test-setup', tenant, scopes: ['devices:pair'] }, pairing.user_code);
  const paired = await runtime.broker.pollPairing(pairing.device_code);
  const devicePrincipal = runtime.tokenService.verify(paired.device_token, { expectedType: 'device' });
  const readOnlyTool = (name) => ({
    name, description: name,
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false }
  });
  await runtime.broker.registerDevice(devicePrincipal, {
    deviceName, platform: 'win32', mcpReady: true,
    tools: [readOnlyTool('read_file'), {
      ...readOnlyTool('write_file'), annotations: { readOnlyHint: false, destructiveHint: true }
    }]
  });
  return devicePrincipal;
}

async function fixture(t, { introspection = () => ({ active: false }), configOverrides = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-readonly-'));
  const issuer = signer();
  const oauthFetchImpl = async (url, init = {}) => {
    if (String(url) === JWKS_URL) return jsonResponse({ keys: [issuer.jwk] });
    if (String(url) === INTROSPECTION_URL) return jsonResponse(introspection(new URLSearchParams(String(init.body)).get('token')));
    return jsonResponse({ error: 'not_found' }, 404);
  };
  const config = configFor(dir, configOverrides);
  const { server, runtime } = await createChatgptRemoteHttpServer(config, { logger: { info() {}, error() {} }, oauthFetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const operatorDevice = await pairDevice(runtime, OPERATOR_TENANT, 'JalenPC');
  const foreignDevice = await pairDevice(runtime, FOREIGN_TENANT, 'ForeignPC');
  return { base: `http://127.0.0.1:${config.port}`, runtime, jwt: issuer.jwt, operatorDevice, foreignDevice };
}

test('read-only ChatGPT resource publishes exact metadata and least read scopes without changing /chatgpt/mcp', async (t) => {
  const f = await fixture(t);

  let out = await jsonFetch(f.base, '/.well-known/oauth-protected-resource/chatgpt/readonly/mcp');
  assert.equal(out.response.status, 200);
  assert.deepEqual(out.body, {
    resource: READONLY_AUDIENCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['devices:read', 'tools:read'],
    bearer_methods_supported: ['header']
  });

  out = await jsonFetch(f.base, '/.well-known/oauth-protected-resource/chatgpt/mcp');
  assert.equal(out.body.resource, CHATGPT_AUDIENCE);
  assert.deepEqual(out.body.scopes_supported, ['devices:read', 'tools:read', 'tools:write', 'tools:execute', 'tools:network']);

  out = await listTools(f.base, '/chatgpt/readonly/mcp', null);
  assert.equal(out.response.status, 401);
  const challenge = out.response.headers.get('www-authenticate') || '';
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /scope="devices:read tools:read"/);
  assert.ok(challenge.includes(`${PUBLIC_URL}/.well-known/oauth-protected-resource/chatgpt/readonly/mcp`));
  assert.doesNotMatch(challenge, /tools:write|tools:execute|tools:network/);

  out = await jsonFetch(f.base, '/chatgpt/readonly/mcp');
  assert.equal(out.response.status, 405);
});

test('read-only ChatGPT resource is OAuth-only: static tokens are rejected even when static MCP compatibility is on', async (t) => {
  const f = await fixture(t);
  const staticToken = f.runtime.tokenService.mint({
    subject: 'static-operator', tenantId: OPERATOR_TENANT, type: 'user',
    scopes: ['devices:read', 'tools:read', 'tools:write', 'tools:execute', 'tools:network']
  });

  const readonly = await listTools(f.base, '/chatgpt/readonly/mcp', staticToken);
  assert.equal(readonly.response.status, 401);
  assert.match(readonly.response.headers.get('www-authenticate') || '', /chatgpt\/readonly\/mcp/);

  // Existing static compatibility callers keep working on the routes that already supported them.
  const full = await listTools(f.base, '/chatgpt/mcp', staticToken);
  assert.equal(full.response.status, 200);
  assert.equal(full.body.result.tools.length, 14);
  const generic = await listTools(f.base, '/mcp', staticToken);
  assert.equal(generic.response.status, 200);
});

test('read-only ChatGPT resource stays closed when no authorization server is configured', async (t) => {
  const f = await fixture(t, { configOverrides: { authorizationServers: [] } });
  const out = await listTools(f.base, '/chatgpt/readonly/mcp', f.jwt(claims()));
  assert.equal(out.response.status, 401);
});

test('Nymrel plugin backend is absent by default and accepts only mapped, plugin-audience OAuth reads when enabled', async (t) => {
  const disabled = await fixture(t);
  let out = await listTools(disabled.base, NYMREL_PLUGIN_ROUTE, disabled.jwt(claims({ aud: NYMREL_PLUGIN_AUDIENCE })));
  assert.equal(out.response.status, 404);

  const f = await fixture(t, { configOverrides: { nymrelPluginReadonlyEnabled: true } });
  out = await jsonFetch(f.base, `/.well-known/oauth-protected-resource${NYMREL_PLUGIN_ROUTE}`);
  assert.equal(out.response.status, 200);
  assert.equal(out.body.resource, NYMREL_PLUGIN_AUDIENCE);
  assert.deepEqual(out.body.authorization_servers, [ISSUER]);
  assert.deepEqual(out.body.scopes_supported, ['devices:read', 'tools:read']);

  out = await listTools(f.base, NYMREL_PLUGIN_ROUTE, null);
  assert.equal(out.response.status, 401);
  assert.match(out.response.headers.get('www-authenticate') || '', /https:\/\/mcp\.nymrel\.com\/\.well-known\/oauth-protected-resource\/mcp/);

  const staticToken = f.runtime.tokenService.mint({
    subject: 'static-operator', tenantId: OPERATOR_TENANT, type: 'user',
    scopes: ['devices:read', 'tools:read']
  });
  assert.equal((await listTools(f.base, NYMREL_PLUGIN_ROUTE, staticToken)).response.status, 401);
  assert.equal((await listTools(f.base, NYMREL_PLUGIN_ROUTE, f.jwt(claims()))).response.status, 401);
  const missingScope = await listTools(f.base, NYMREL_PLUGIN_ROUTE,
    f.jwt(claims({ aud: NYMREL_PLUGIN_AUDIENCE, scope: 'devices:read' })));
  assert.equal(missingScope.response.status, 403);
  assert.match(missingScope.response.headers.get('www-authenticate') || '', /error="insufficient_scope"/);

  const token = f.jwt(claims({ aud: NYMREL_PLUGIN_AUDIENCE, tenant: FOREIGN_TENANT, tid: FOREIGN_TENANT }));
  out = await listTools(f.base, NYMREL_PLUGIN_ROUTE, token);
  assert.equal(out.response.status, 200);
  assert.deepEqual(out.body.result.tools.map((tool) => tool.name), CHATGPT_READONLY_TOOL_NAMES);
  out = await callTool(f.base, NYMREL_PLUGIN_ROUTE, token, 'list_devices');
  assert.equal(out.response.status, 200);
  assert.match(JSON.stringify(out.body.result), /JalenPC/);
  assert.doesNotMatch(JSON.stringify(out.body.result), /ForeignPC/);

  for (const name of ['write_file', 'edit_block', 'start_process', 'kill_process']) {
    out = await callTool(f.base, NYMREL_PLUGIN_ROUTE, token, name, { device: 'JalenPC', path: 'a.txt' });
    assert.equal(out.body.error.data.code, 'NOT_FOUND', name);
  }
  assert.equal((await f.runtime.broker.listQueuedForDevice(f.operatorDevice)).length, 0);
});

test('Nymrel plugin pending results are isolated from the direct ChatGPT read-only profile', async (t) => {
  const f = await fixture(t, { configOverrides: { nymrelPluginReadonlyEnabled: true } });
  const pluginToken = f.jwt(claims({ aud: NYMREL_PLUGIN_AUDIENCE }));
  const directToken = f.jwt(claims());
  const started = await callTool(f.base, NYMREL_PLUGIN_ROUTE, pluginToken, 'read_file', { device: 'JalenPC', path: 'notes/a.txt' });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.result.structuredContent.pending, true);
  const callId = started.body.result.structuredContent.call.id;
  assert.equal(typeof callId, 'string');

  let out = await callTool(f.base, NYMREL_PLUGIN_ROUTE, pluginToken, 'get_read_result', { callId });
  assert.equal(out.response.status, 200);
  assert.equal(out.body.result.structuredContent.pending, true);

  out = await callTool(f.base, '/chatgpt/readonly/mcp', directToken, 'get_read_result', { callId });
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
});

test('mapped OAuth subject gets the frozen seven-tool catalog and only its mapped tenant, whatever tenant the token claims', async (t) => {
  const f = await fixture(t);
  // The tenant claim names the foreign tenant; it must never select a tenant.
  const token = f.jwt(claims({ tenant: FOREIGN_TENANT, tid: FOREIGN_TENANT }));

  let out = await listTools(f.base, '/chatgpt/readonly/mcp', token);
  assert.equal(out.response.status, 200);
  assert.deepEqual(out.body.result.tools.map((tool) => tool.name), CHATGPT_READONLY_TOOL_NAMES);

  out = await callTool(f.base, '/chatgpt/readonly/mcp', token, 'list_devices');
  assert.equal(out.response.status, 200);
  const listed = JSON.stringify(out.body.result);
  assert.match(listed, /JalenPC/);
  assert.doesNotMatch(listed, /ForeignPC/);

  out = await callTool(f.base, '/chatgpt/readonly/mcp', token, 'read_file', { device: 'ForeignPC', path: 'secret.txt' });
  // Tool-level failures are JSON-RPC errors; the foreign device must be invisible, not merely refused.
  assert.equal(out.body.result, undefined);
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  assert.equal((await f.runtime.broker.listQueuedForDevice(f.foreignDevice)).length, 0);

  out = await callTool(f.base, '/chatgpt/readonly/mcp', token, 'read_file', { device: 'JalenPC', path: 'notes/a.txt' });
  assert.equal(out.response.status, 200);
  const queued = await f.runtime.broker.listQueuedForDevice(f.operatorDevice);
  assert.equal(queued.length, 1);
  const claim = await f.runtime.broker.claimCall(f.operatorDevice, queued[0].callId);
  assert.equal(claim.toolName, 'read_file');
  assert.deepEqual(claim.args, { path: 'notes/a.txt' });
});

test('read-only ChatGPT resource returns not-found for mutation and execution tools before the broker is reached', async (t) => {
  const f = await fixture(t);
  // Even a token that carries broad scopes cannot widen the read-only resource.
  const token = f.jwt(claims({ scope: 'devices:read tools:read tools:write tools:execute tools:network' }));
  for (const name of ['write_file', 'edit_block', 'start_process', 'kill_process', 'read_process_output']) {
    const out = await callTool(f.base, '/chatgpt/readonly/mcp', token, name, { device: 'JalenPC', path: 'a.txt', command: 'whoami' });
    assert.equal(out.body.result, undefined, name);
    assert.equal(out.body.error.data.code, 'NOT_FOUND', name);
    assert.match(out.body.error.message, /read-only ChatGPT tool not found/, name);
  }
  assert.equal((await f.runtime.broker.listQueuedForDevice(f.operatorDevice)).length, 0);
});

test('read-only ChatGPT resource honors only the exact read scopes', async (t) => {
  const f = await fixture(t);
  const out = await callTool(f.base, '/chatgpt/readonly/mcp', f.jwt(claims({ scope: 'tools:* *' })), 'list_devices');
  assert.equal(out.response.status, 403);
  const challenge = out.response.headers.get('www-authenticate') || '';
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="devices:read"/);
});

test('unmapped or missing OAuth subjects fail closed on every public external-OAuth entry point', async (t) => {
  const f = await fixture(t);
  const broadScope = 'devices:read devices:pair devices:revoke calls:read calls:approve audit:read tools:read tools:write tools:execute tools:network';
  const routes = [
    ['/chatgpt/readonly/mcp', READONLY_AUDIENCE],
    ['/chatgpt/mcp', CHATGPT_AUDIENCE],
    ['/mcp', MCP_AUDIENCE]
  ];

  for (const [route, aud] of routes) {
    // A self-signed-up account that claims the operator tenant is still a foreign subject.
    const foreign = f.jwt(claims({ sub: 'auth0|self-signup', aud, scope: broadScope, tenant: OPERATOR_TENANT, tid: OPERATOR_TENANT }));
    let out = await listTools(f.base, route, foreign);
    assert.equal(out.response.status, 403, route);
    assert.equal(out.body.error.code, 'OAUTH_SUBJECT_DENIED', route);
    out = await callTool(f.base, route, foreign, route === '/mcp' ? 'nymrel_remote_list_devices' : 'list_devices');
    assert.equal(out.response.status, 403, route);

    for (const sub of ['', undefined, 42, ' auth0|operator', 'AUTH0|OPERATOR']) {
      out = await listTools(f.base, route, f.jwt(claims({ sub, aud, scope: broadScope })));
      assert.ok([401, 403].includes(out.response.status), `${route} sub=${JSON.stringify(sub)}`);
    }
  }

  const operatorApi = f.jwt(claims({ sub: 'auth0|self-signup', aud: MCP_AUDIENCE, scope: broadScope, tenant: OPERATOR_TENANT }));
  for (const [method, route] of [['GET', '/v1/devices'], ['GET', '/v1/calls'], ['GET', '/v1/audit/verify'], ['POST', '/v1/pairings/approve']]) {
    const out = await jsonFetch(f.base, route, {
      method, headers: { authorization: `Bearer ${operatorApi}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ user_code: 'AAAA-BBBB' }) } : {})
    });
    assert.equal(out.response.status, 403, route);
    assert.equal(out.body.error.code, 'OAUTH_SUBJECT_DENIED', route);
  }

  const mappedOperatorApi = f.jwt(claims({ aud: MCP_AUDIENCE, scope: broadScope, tenant: FOREIGN_TENANT }));
  const devices = await jsonFetch(f.base, '/v1/devices', { headers: { authorization: `Bearer ${mappedOperatorApi}` } });
  assert.equal(devices.response.status, 200);
  assert.deepEqual(devices.body.devices.map((device) => device.name), ['JalenPC']);

  assert.equal((await f.runtime.broker.listQueuedForDevice(f.operatorDevice)).length, 0);
});

test('an empty subject mapping denies every external OAuth principal', async (t) => {
  for (const oauthSubjectTenants of [new Map(), undefined]) {
    const f = await fixture(t, { configOverrides: { oauthSubjectTenants } });
    for (const [route, aud] of [['/chatgpt/readonly/mcp', READONLY_AUDIENCE], ['/chatgpt/mcp', CHATGPT_AUDIENCE], ['/mcp', MCP_AUDIENCE]]) {
      const out = await listTools(f.base, route, f.jwt(claims({ aud })));
      assert.equal(out.response.status, 403, route);
    }
  }
});

test('tokens are bound to the exact resource audience, issuer, signature, and lifetime', async (t) => {
  const f = await fixture(t);
  const nowSec = Math.floor(Date.now() / 1000);

  for (const [route, aud] of [
    ['/chatgpt/readonly/mcp', CHATGPT_AUDIENCE],
    ['/chatgpt/readonly/mcp', MCP_AUDIENCE],
    ['/chatgpt/readonly/mcp', `${READONLY_AUDIENCE}/`],
    ['/chatgpt/readonly/mcp', PUBLIC_URL],
    ['/chatgpt/mcp', READONLY_AUDIENCE],
    ['/mcp', READONLY_AUDIENCE]
  ]) {
    const out = await listTools(f.base, route, f.jwt(claims({ aud })));
    assert.equal(out.response.status, 401, `${route} must reject audience ${aud}`);
  }

  const rejected = {
    'missing audience': f.jwt(claims({ aud: undefined })),
    'expired token': f.jwt(claims({ exp: nowSec - 3600 })),
    'not yet valid token': f.jwt(claims({ nbf: nowSec + 3600 })),
    'issuer without the exact trailing slash': f.jwt(claims({ iss: ISSUER.replace(/\/$/, '') })),
    'foreign issuer': f.jwt(claims({ iss: 'https://attacker.example.test/' })),
    'token signed by an unknown key': signer().jwt(claims()),
    'unsigned token': `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims())}.`
  };
  for (const [label, token] of Object.entries(rejected)) {
    const out = await listTools(f.base, '/chatgpt/readonly/mcp', token);
    assert.equal(out.response.status, 401, label);
    assert.match(out.response.headers.get('www-authenticate') || '', /chatgpt\/readonly\/mcp/, label);
  }

  const accepted = await listTools(f.base, '/chatgpt/readonly/mcp', f.jwt(claims()));
  assert.equal(accepted.response.status, 200);
});

test('revoked opaque tokens are rejected through introspection and active ones still need a mapped subject', async (t) => {
  const f = await fixture(t, {
    introspection: (token) => {
      if (token === 'opaque-active-operator') return { active: true, iss: ISSUER, sub: OPERATOR_SUBJECT, aud: READONLY_AUDIENCE, scope: READ_SCOPE, tenant: FOREIGN_TENANT };
      if (token === 'opaque-active-foreign') return { active: true, iss: ISSUER, sub: 'auth0|self-signup', aud: READONLY_AUDIENCE, scope: READ_SCOPE, tenant: OPERATOR_TENANT };
      if (token === 'opaque-wrong-audience') return { active: true, iss: ISSUER, sub: OPERATOR_SUBJECT, aud: CHATGPT_AUDIENCE, scope: READ_SCOPE };
      return { active: false };
    }
  });

  let out = await callTool(f.base, '/chatgpt/readonly/mcp', 'opaque-active-operator', 'list_devices');
  assert.equal(out.response.status, 200);
  assert.doesNotMatch(JSON.stringify(out.body.result), /ForeignPC/);

  out = await listTools(f.base, '/chatgpt/readonly/mcp', 'opaque-revoked-operator');
  assert.equal(out.response.status, 401);
  out = await listTools(f.base, '/chatgpt/readonly/mcp', 'opaque-wrong-audience');
  assert.equal(out.response.status, 401);
  out = await listTools(f.base, '/chatgpt/readonly/mcp', 'opaque-active-foreign');
  assert.equal(out.response.status, 403);
});

test('the read-only audience cannot be shared with another MCP resource', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-readonly-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    createChatgptRemoteHttpServer(configFor(dir, { production: true, oauthAudience: READONLY_AUDIENCE }), { logger: { info() {}, error() {} } }),
    /must not be shared/
  );
  // Reject bad deployment configuration before acquiring a live production lease.
  await assert.rejects(fs.access(path.join(dir, 'state.json.server-lease')), { code: 'ENOENT' });
  const { server, runtime } = await createChatgptRemoteHttpServer(configFor(dir, { production: true }), { logger: { info() {}, error() {} } });
  await runtime.instanceLease.release();
  server.close();
});

test('pending read results can be polled through completion without creating or executing another call', async (t) => {
  const f = await fixture(t);
  const token = f.jwt(claims());
  const route = '/chatgpt/readonly/mcp';
  const initial = await callTool(f.base, route, token, 'read_file', { path: 'INDEX.md' });
  const callId = initial.body.result.structuredContent.call.id;
  assert.equal(initial.body.result.structuredContent.pending, true);
  assert.match(initial.body.result.content.at(-1).text, /get_read_result/);
  const before = await f.runtime.store.read();
  assert.equal(before.calls[callId].sourceProfile, 'chatgpt-readonly');
  const created = before.receipts.filter((item) => item.event === 'call.created').length;

  const poll = () => callTool(f.base, route, token, 'get_read_result', { callId });
  let out = await poll();
  assert.equal(out.body.result.structuredContent.call.status, 'queued');
  await f.runtime.broker.claimCall(f.operatorDevice, callId);
  out = await poll();
  assert.equal(out.body.result.structuredContent.call.status, 'executing');
  const result = { content: [{ type: 'text', text: 'delayed-read-complete' }], structuredContent: { text: 'delayed-read-complete' } };
  await f.runtime.broker.completeCall(f.operatorDevice, callId, result);
  for (let retry = 0; retry < 2; retry++) {
    out = await poll();
    assert.equal(out.response.status, 200);
    assert.deepEqual(out.body.result.content, result.content);
    assert.deepEqual(out.body.result.structuredContent, result.structuredContent);
  }
  const after = await f.runtime.store.read();
  assert.equal(Object.keys(after.calls).length, 1);
  assert.equal(after.receipts.filter((item) => item.event === 'call.created').length, created);
  assert.equal((await f.runtime.broker.listQueuedForDevice(f.operatorDevice)).length, 0);
});

test('read result retrieval rejects other subjects, tenants, profiles, legacy calls and missing scopes', async (t) => {
  const f = await fixture(t, { configOverrides: { oauthSubjectTenants: new Map([
    [OPERATOR_SUBJECT, OPERATOR_TENANT], ['auth0|coworker', OPERATOR_TENANT], ['auth0|foreign', FOREIGN_TENANT]
  ]) } });
  const route = '/chatgpt/readonly/mcp';
  const token = f.jwt(claims());
  const initial = await callTool(f.base, route, token, 'read_file', { path: 'INDEX.md' });
  const callId = initial.body.result.structuredContent.call.id;
  for (const sub of ['auth0|coworker', 'auth0|foreign']) {
    const out = await callTool(f.base, route, f.jwt(claims({ sub })), 'get_read_result', { callId });
    assert.equal(out.body.error.data.code, 'NOT_FOUND');
  }
  for (const scope of ['devices:read', 'tools:read', '* tools:* calls:read']) {
    const out = await callTool(f.base, route, f.jwt(claims({ scope })), 'get_read_result', { callId });
    assert.equal(out.response.status, 403);
  }
  const full = await callTool(f.base, '/chatgpt/mcp', f.jwt(claims({ aud: CHATGPT_AUDIENCE })),
    'read_file', { path: 'INDEX.md', sourceProfile: 'chatgpt-readonly' });
  const fullId = full.body.result.structuredContent.call.id;
  let out = await callTool(f.base, route, token, 'get_read_result', { callId: fullId });
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  out = await callTool(f.base, '/chatgpt/mcp', f.jwt(claims({ aud: CHATGPT_AUDIENCE })), 'get_read_result', { callId });
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  await f.runtime.store.transaction((state) => { delete state.calls[callId].sourceProfile; });
  out = await callTool(f.base, route, token, 'get_read_result', { callId });
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  assert.equal(Object.keys((await f.runtime.store.read()).calls).length, 2);
});

test('read result retrieval rechecks policy and device revocation and reports terminal failures', async (t) => {
  const f = await fixture(t);
  const route = '/chatgpt/readonly/mcp';
  const token = f.jwt(claims());
  const initial = await callTool(f.base, route, token, 'read_file', { path: 'INDEX.md' });
  const callId = initial.body.result.structuredContent.call.id;
  const poll = () => callTool(f.base, route, token, 'get_read_result', { callId });
  await f.runtime.broker.claimCall(f.operatorDevice, callId);
  await f.runtime.broker.failCall(f.operatorDevice, callId, 'fixture read failed');
  let out = await poll();
  assert.equal(out.body.result.isError, true);
  assert.match(out.body.result.content[0].text, /fixture read failed/);
  for (const status of ['expired', 'cancelled']) {
    await f.runtime.store.transaction((state) => { state.calls[callId].status = status; });
    out = await poll();
    assert.equal(out.body.result.isError, true);
    assert.equal(out.body.result.structuredContent.call.status, status);
  }
  f.runtime.broker.policy.rules.read = 'deny';
  out = await poll();
  assert.equal(out.body.error.data.code, 'POLICY_DENIED');
  f.runtime.broker.policy.rules.read = 'auto';
  // A changed or removed device schema must not disclose a retained result.
  const originalState = await f.runtime.store.read();
  const deviceId = originalState.calls[callId].deviceId;
  await f.runtime.store.transaction((state) => { state.devices[deviceId].tools = []; });
  out = await poll();
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  await f.runtime.store.transaction((state) => { state.devices[deviceId].tools = originalState.devices[deviceId].tools; });
  await f.runtime.broker.revokeDevice({ typ: 'user', sub: OPERATOR_SUBJECT, tenant: OPERATOR_TENANT,
    scopes: ['devices:revoke'] }, deviceId);
  out = await poll();
  assert.equal(out.body.error.data.code, 'NOT_FOUND');
  assert.equal(Object.keys((await f.runtime.store.read()).calls).length, 1);
});
