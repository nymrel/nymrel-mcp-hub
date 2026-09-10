import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatgptMcpEdge, CHATGPT_REMOTE_TOOLS } from '../src/chatgpt-mcp-edge.js';
import { createChatgptRemoteHttpServer } from '../src/chatgpt-server.js';
import { CLIENT_CAPABILITIES_META_KEY, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '../src/mcp-protocol.js';

const key = Buffer.alloc(32, 29);

function configFor(dir) {
  return {
    production: false, host: '127.0.0.1', port: 0, publicBaseUrl: null,
    storePath: path.join(dir, 'state.json'), signingKey: key, dataKey: key, auditKey: key,
    bootstrapToken: 'bootstrap-test-token-not-for-production', callTtlMs: 60_000, syncWaitMs: 0,
    heartbeatTtlMs: 60_000, pairingTtlMs: 60_000, maxBodyBytes: 1024 * 1024,
    maxToolSchemaBytes: 65536, maxToolsPerDevice: 64, allowedOrigins: [], authorizationServers: [],
    allowStaticMcpTokens: true, allowStaticAdminTokens: true, allowBootstrapHttp: true,
    oauthIssuer: null, oauthJwksUrl: null, oauthAudience: null, oauthTenantClaim: 'tenant', oauthIntrospectionUrl: null,
    oauthIntrospectionClientId: null, oauthIntrospectionClientSecret: null
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

test('ChatGPT tool catalog is static and every action has explicit review hints', async () => {
  const names = CHATGPT_REMOTE_TOOLS.map((tool) => tool.name);
  assert.equal(names.length, new Set(names).size);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('start_process'));
  assert.ok(names.includes('list_devices'));

  for (const tool of CHATGPT_REMOTE_TOOLS) {
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} openWorldHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
  }
  const read = CHATGPT_REMOTE_TOOLS.find((tool) => tool.name === 'read_file');
  assert.ok(read.inputSchema.properties.device);
  assert.ok(read.inputSchema.required.includes('path'));
  assert.equal(read.annotations.readOnlyHint, true);
  const shell = CHATGPT_REMOTE_TOOLS.find((tool) => tool.name === 'start_process');
  assert.equal(shell.annotations.openWorldHint, true);
  assert.equal(shell.annotations.destructiveHint, true);
});

test('stable device tool resolves to the current projected tool without forwarding device as an argument', async () => {
  let created = null;
  const broker = {
    async listDevices() {
      return [{ id: 'dev_1', name: 'JalenPC', status: 'online', mcpReady: true }];
    },
    async projectedTools() {
      return [{
        name: 'remote_jalenpc_deadbeef__read_file',
        _meta: { 'nymrel/deviceId': 'dev_1', 'nymrel/originalToolName': 'read_file' }
      }];
    },
    async createCall(_principal, projectedName, args) {
      created = { projectedName, args };
      return { id: 'call_1', status: 'queued' };
    },
    async waitForOwnCall() {
      return { id: 'call_1', status: 'completed', result: { content: [{ type: 'text', text: 'native-ok' }] } };
    }
  };
  const edge = new ChatgptMcpEdge({ broker, syncWaitMs: 0 });
  const result = await edge.callTool({ typ: 'user', sub: 'u1', tenant: 't1', scopes: ['tools:read'] }, 'read_file', {
    device: 'JalenPC', path: 'notes/a.txt'
  });
  assert.equal(result.content[0].text, 'native-ok');
  assert.deepEqual(created, {
    projectedName: 'remote_jalenpc_deadbeef__read_file',
    args: { path: 'notes/a.txt' }
  });
});

test('ChatGPT HTTP endpoint keeps a frozen action catalog while device registration changes underneath it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-chatgpt-'));
  const config = configFor(dir);
  const { server, runtime } = await createChatgptRemoteHttpServer(config, { logger: { info() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;

  try {
    let out = await jsonFetch(base, '/.well-known/oauth-protected-resource/chatgpt/mcp');
    assert.equal(out.response.status, 200);
    assert.equal(out.body.resource, `${base}/chatgpt/mcp`);
    assert.ok(out.body.scopes_supported.includes('tools:execute'));

    const operatorToken = runtime.tokenService.mint({
      subject: 'operator', tenantId: 't1', type: 'user',
      scopes: ['devices:pair', 'devices:read', 'devices:revoke', 'calls:read', 'calls:approve', 'audit:read', 'tools:read', 'tools:write', 'tools:execute', 'tools:network']
    });
    const listBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } };
    const headers = {
      authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list'
    };
    out = await jsonFetch(base, '/chatgpt/mcp', { method: 'POST', headers, body: JSON.stringify(listBody) });
    assert.equal(out.response.status, 200);
    const before = out.body.result.tools.map((tool) => tool.name);

    const pairing = await runtime.broker.startPairing({ deviceName: 'JalenPC', platform: 'win32' });
    const principal = runtime.tokenService.verify(operatorToken, { expectedType: 'user' });
    await runtime.broker.approvePairing(principal, pairing.user_code);
    const paired = await runtime.broker.pollPairing(pairing.device_code);
    const devicePrincipal = runtime.tokenService.verify(paired.device_token, { expectedType: 'device' });
    await runtime.broker.registerDevice(devicePrincipal, {
      deviceName: 'JalenPC', platform: 'win32', mcpReady: true,
      tools: [{
        name: 'read_file', description: 'read file',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
        annotations: { readOnlyHint: true, destructiveHint: false }
      }]
    });

    out = await jsonFetch(base, '/chatgpt/mcp', { method: 'POST', headers, body: JSON.stringify(listBody) });
    assert.equal(out.response.status, 200);
    assert.deepEqual(out.body.result.tools.map((tool) => tool.name), before);

    const callBody = {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'read_file', arguments: { device: 'JalenPC', path: 'notes/a.txt' }, _meta: modernMeta() }
    };
    out = await jsonFetch(base, '/chatgpt/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-method': 'tools/call', 'mcp-name': 'read_file' },
      body: JSON.stringify(callBody)
    });
    assert.equal(out.response.status, 200);
    const queued = await runtime.broker.listQueuedForDevice(devicePrincipal);
    assert.equal(queued.length, 1);
    const claim = await runtime.broker.claimCall(devicePrincipal, queued[0].callId);
    assert.equal(claim.toolName, 'read_file');
    assert.deepEqual(claim.args, { path: 'notes/a.txt' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
