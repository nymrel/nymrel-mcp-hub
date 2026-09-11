import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteHttpServer } from '../src/server.js';
import { CLIENT_CAPABILITIES_META_KEY, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '../src/mcp-protocol.js';

const key = Buffer.alloc(32, 19);

function configFor(dir) {
  return {
    production: false, host: '127.0.0.1', port: 0, publicBaseUrl: null,
    storePath: path.join(dir, 'state.json'), signingKey: key, dataKey: key, auditKey: key,
    bootstrapToken: 'bootstrap-test-token-not-for-production', callTtlMs: 60_000, syncWaitMs: 0,
    heartbeatTtlMs: 60_000, pairingTtlMs: 60_000, maxBodyBytes: 1024 * 1024,
    maxToolSchemaBytes: 65536, maxToolsPerDevice: 64, allowedOrigins: [], authorizationServers: [], allowStaticMcpTokens: true, allowStaticAdminTokens: true, allowBootstrapHttp: true,
    oauthIssuer: null, oauthJwksUrl: null, oauthAudience: null, oauthTenantClaim: 'tenant', oauthIntrospectionUrl: null,
    oauthIntrospectionClientId: null, oauthIntrospectionClientSecret: null
  };
}

async function jsonFetch(base, route, init = {}) {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-http-'));
  const config = configFor(dir);
  const logs = [];
  const { server, runtime } = await createRemoteHttpServer(config, { logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  return { dir, config, server, runtime, base, logs };
}

async function stopServer(f) {
  await new Promise((resolve) => f.server.close(resolve));
  await fs.rm(f.dir, { recursive: true, force: true });
}

function modernMeta(extraCaps = {}) {
  return { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: extraCaps };
}

test('HTTP boundary exposes readiness/resource metadata, rejects hostile Origin, and challenges unauthenticated MCP', async () => {
  const f = await startServer();
  try {
    let out = await jsonFetch(f.base, '/healthz');
    assert.equal(out.response.status, 200);
    out = await jsonFetch(f.base, '/readyz');
    assert.equal(out.response.status, 200);
    assert.equal(out.body.audit.valid, true);
    out = await jsonFetch(f.base, '/.well-known/oauth-protected-resource');
    assert.equal(out.response.status, 200);
    assert.equal(out.body.resource, `${f.base}/mcp`);
    assert.deepEqual(out.body.bearer_methods_supported, ['header']);

    out = await jsonFetch(f.base, '/healthz', { headers: { origin: 'https://evil.example' } });
    assert.equal(out.response.status, 403);
    assert.equal(out.body.error.code, 'ORIGIN_DENIED');

    out = await jsonFetch(f.base, '/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } })
    });
    assert.equal(out.response.status, 401);
    assert.match(out.response.headers.get('www-authenticate'), /resource_metadata=/);
  } finally { await stopServer(f); }
});

test('HTTP pairing/register flow and modern tools/list preserve device schema exactly', async () => {
  const f = await startServer();
  try {
    const operatorToken = f.runtime.tokenService.mint({
      subject: 'operator', tenantId: 't1', type: 'user',
      scopes: ['devices:pair', 'devices:read', 'calls:read', 'calls:approve', 'audit:read', 'tools:read', 'tools:write']
    });
    let out = await jsonFetch(f.base, '/v1/pairings/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceName: 'JalenPC', platform: 'win32' })
    });
    const pairing = out.body;
    out = await jsonFetch(f.base, '/v1/pairings/approve', {
      method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: pairing.user_code })
    });
    assert.equal(out.response.status, 200);
    out = await jsonFetch(f.base, '/v1/pairings/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: pairing.device_code })
    });
    const device = out.body;
    assert.equal(device.status, 'approved');

    const editSchema = {
      type: 'object', required: ['file_path'],
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      additionalProperties: false
    };
    out = await jsonFetch(f.base, '/v1/device/register', {
      method: 'POST', headers: { authorization: `Bearer ${device.device_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName: 'JalenPC', platform: 'win32', mcpReady: true, tools: [{ name: 'edit_block', description: 'edit', inputSchema: editSchema }] })
    });
    assert.equal(out.response.status, 200);
    assert.equal(out.body.status, 'online');

    const body = { jsonrpc: '2.0', id: 10, method: 'tools/list', params: { _meta: modernMeta() } };
    out = await jsonFetch(f.base, '/mcp', {
      method: 'POST', headers: {
        authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list'
      }, body: JSON.stringify(body)
    });
    assert.equal(out.response.status, 200);
    const projected = out.body.result.tools.find((tool) => tool._meta?.['nymrel/originalToolName'] === 'edit_block');
    assert.ok(projected);
    assert.deepEqual(projected.inputSchema, editSchema);

    const mismatched = await jsonFetch(f.base, '/mcp', {
      method: 'POST', headers: {
        authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'wrong'
      }, body: JSON.stringify(body)
    });
    assert.equal(mismatched.response.status, 400);
    assert.equal(mismatched.body.error.code, -32020);
  } finally { await stopServer(f); }
});

test('HTTP MCP read call completes through durable device claim without exposing args/results in logs', async () => {
  const f = await startServer();
  try {
    f.runtime.mcp.syncWaitMs = 10_000;
    const operator = { typ: 'user', sub: 'operator', tenant: 't1', scopes: ['devices:pair', 'devices:read', 'calls:read', 'calls:approve', 'audit:read', 'tools:read'] };
    const operatorToken = f.runtime.tokenService.mint({ subject: operator.sub, tenantId: operator.tenant, type: 'user', scopes: operator.scopes });
    const pairing = await f.runtime.broker.startPairing({ deviceName: 'JalenPC', platform: 'win32' });
    await f.runtime.broker.approvePairing(operator, pairing.user_code);
    const paired = await f.runtime.broker.pollPairing(pairing.device_code);
    const devicePrincipal = f.runtime.tokenService.verify(paired.device_token, { expectedType: 'device' });
    await f.runtime.broker.registerDevice(devicePrincipal, {
      deviceName: 'JalenPC', platform: 'win32', mcpReady: true,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }]
    });
    const projected = (await f.runtime.broker.projectedTools(operator))[0];
    const args = { path: 'C:/sensitive-mcp-path-47ab.txt' };
    const request = { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: projected.name, arguments: args, _meta: modernMeta() } };

    const mcpPromise = jsonFetch(f.base, '/mcp', {
      method: 'POST', headers: {
        authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/call', 'mcp-name': projected.name
      }, body: JSON.stringify(request)
    });

    let queued = [];
    const queueDeadline = Date.now() + 5_000;
    while (Date.now() < queueDeadline && queued.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      queued = await f.runtime.broker.listQueuedForDevice(devicePrincipal);
    }
    assert.equal(queued.length, 1);
    const claim = await f.runtime.broker.claimCall(devicePrincipal, queued[0].callId);
    assert.deepEqual(claim.args, args);
    await f.runtime.broker.completeCall(devicePrincipal, queued[0].callId, { content: [{ type: 'text', text: 'safe visible answer' }] });

    const out = await mcpPromise;
    assert.equal(out.response.status, 200);
    assert.equal(out.body.result.content[0].text, 'safe visible answer');
    assert.equal(f.logs.join('\n').includes('sensitive-mcp-path-47ab'), false);
    assert.equal(f.logs.join('\n').includes('safe visible answer'), false);
  } finally { await stopServer(f); }
});
