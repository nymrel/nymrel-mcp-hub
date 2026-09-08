import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../src/store.js';
import { TokenService } from '../src/token.js';
import { EnvelopeCipher } from '../src/crypto.js';
import { AuditLedger } from '../src/audit.js';
import { PolicyEngine } from '../src/policy.js';
import { RemoteBroker } from '../src/broker.js';
import { RemoteMcpEdge } from '../src/mcp-edge.js';
import { CLIENT_CAPABILITIES_META_KEY, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '../src/mcp-protocol.js';

const key = Buffer.alloc(32, 11);

async function fixture({ callTtlMs = 60_000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-broker-'));
  const store = await new JsonFileStore(path.join(dir, 'state.json')).init();
  const tokenService = new TokenService(key);
  const broker = await new RemoteBroker({
    store, tokenService, cipher: new EnvelopeCipher(key), audit: new AuditLedger(key), policy: new PolicyEngine(),
    config: { pairingTtlMs: 60_000, heartbeatTtlMs: 60_000, callTtlMs, syncWaitMs: 0, maxToolsPerDevice: 32, maxToolSchemaBytes: 65536, maxBodyBytes: 1024 * 1024 }
  }).init();
  const operator = { typ: 'user', sub: 'operator', tenant: 't1', scopes: ['devices:pair', 'devices:read', 'devices:revoke', 'calls:approve', 'calls:read', 'audit:read', 'tools:read', 'tools:write', 'tools:execute'] };
  const pairing = await broker.startPairing({ deviceName: 'JalenPC', platform: 'win32' });
  await broker.approvePairing(operator, pairing.user_code);
  const firstPoll = await broker.pollPairing(pairing.device_code);
  const secondPoll = await broker.pollPairing(pairing.device_code);
  assert.equal(secondPoll.device_id, firstPoll.device_id);
  assert.equal(secondPoll.device_token, firstPoll.device_token);
  const devicePrincipal = tokenService.verify(firstPoll.device_token, { expectedType: 'device' });
  const editSchema = {
    type: 'object', required: ['file_path'],
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    additionalProperties: false
  };
  await broker.registerDevice(devicePrincipal, {
    deviceName: 'JalenPC', platform: 'win32', mcpReady: true,
    tools: [
      { name: 'read_file', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'edit_block', inputSchema: editSchema, annotations: { readOnlyHint: false } }
    ]
  });
  return { dir, store, tokenService, broker, operator, devicePrincipal, editSchema, deviceId: firstPoll.device_id };
}

async function cleanup(f) { await fs.rm(f.dir, { recursive: true, force: true }); }

test('pairing poll is idempotent and device token can roll forward without changing revocation generation', async () => {
  const f = await fixture();
  try {
    const refreshed = await f.broker.refreshDeviceToken(f.devicePrincipal);
    const claims = f.tokenService.verify(refreshed.device_token, { expectedType: 'device' });
    assert.equal(claims.sub, f.devicePrincipal.sub);
    assert.equal(claims.tokenVersion, f.devicePrincipal.tokenVersion);
  } finally { await cleanup(f); }
});

test('durable calls encrypt arguments/results and exactly one concurrent claim wins', async () => {
  const f = await fixture();
  try {
    const tools = await f.broker.projectedTools(f.operator);
    const projectedRead = tools.find((t) => t._meta['nymrel/originalToolName'] === 'read_file');
    const args = { path: 'C:/top-secret-marker-82f1.txt' };
    const call = await f.broker.createCall(f.operator, projectedRead.name, args);
    assert.equal(call.status, 'queued');
    const results = await Promise.allSettled([
      f.broker.claimCall(f.devicePrincipal, call.id),
      f.broker.claimCall(f.devicePrincipal, call.id)
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter((x) => x.status === 'rejected').length, 1);
    const claim = results.find((x) => x.status === 'fulfilled').value;
    assert.deepEqual(claim.args, args);
    await f.broker.completeCall(f.devicePrincipal, call.id, { text: 'private-result-marker-771' });
    const raw = await fs.readFile(f.store.filePath, 'utf8');
    assert.equal(raw.includes('top-secret-marker-82f1'), false);
    assert.equal(raw.includes('private-result-marker-771'), false);
    const completed = await f.broker.getCall(f.operator, call.id, { includeResult: true });
    assert.deepEqual(completed.result, { text: 'private-result-marker-771' });
    assert.equal((await f.broker.verifyAudit(f.operator)).valid, true);
  } finally { await cleanup(f); }
});

test('write calls require approval and MRTR state is principal, args, and schema bound', async () => {
  const f = await fixture();
  try {
    const edge = new RemoteMcpEdge({ broker: f.broker, syncWaitMs: 0 });
    const tools = await f.broker.projectedTools(f.operator);
    const projectedEdit = tools.find((t) => t._meta['nymrel/originalToolName'] === 'edit_block');
    assert.deepEqual(projectedEdit.inputSchema, f.editSchema);
    const args = { file_path: 'C:/project/a.txt', old_string: 'a', new_string: 'b' };
    const params = {
      name: projectedEdit.name, arguments: args,
      _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } }
    };
    const first = await edge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, f.operator);
    assert.equal(first.result.resultType, 'input_required');
    assert.ok(first.result.requestState);
    assert.equal(first.result.inputRequests.remote_approval.method, 'elicitation/create');

    const otherPrincipal = { ...f.operator, sub: 'other-user' };
    const crossUser = await edge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      ...params, requestState: first.result.requestState,
      inputResponses: { remote_approval: { action: 'accept', content: { confirm: true } } }
    } }, otherPrincipal);
    assert.equal(crossUser.error.data.code, 'INVALID_REQUEST_STATE');

    const altered = await edge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      ...params, arguments: { ...args, new_string: 'attacker-change' }, requestState: first.result.requestState,
      inputResponses: { remote_approval: { action: 'accept', content: { confirm: true } } }
    } }, f.operator);
    assert.equal(altered.error.data.code, 'INVALID_REQUEST_STATE');

    const accepted = await edge.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      ...params, requestState: first.result.requestState,
      inputResponses: { remote_approval: { action: 'accept', content: { confirm: true } } }
    } }, f.operator);
    assert.equal(accepted.result.structuredContent.call.status, 'queued');
    const queued = await f.broker.listQueuedForDevice(f.devicePrincipal);
    assert.equal(queued.length, 1);
  } finally { await cleanup(f); }
});

test('MRTR decline cancels rather than dispatching a write', async () => {
  const f = await fixture();
  try {
    const edge = new RemoteMcpEdge({ broker: f.broker, syncWaitMs: 0 });
    const projectedEdit = (await f.broker.projectedTools(f.operator)).find((t) => t._meta['nymrel/originalToolName'] === 'edit_block');
    const args = { file_path: 'C:/project/a.txt', old_string: 'a', new_string: 'b' };
    const meta = { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } };
    const first = await edge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: projectedEdit.name, arguments: args, _meta: meta } }, f.operator);
    const declined = await edge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: projectedEdit.name, arguments: args, _meta: meta, requestState: first.result.requestState,
      inputResponses: { remote_approval: { action: 'decline' } }
    } }, f.operator);
    assert.equal(declined.result.isError, true);
    assert.match(declined.result.content[0].text, /cancelled/);
    assert.equal((await f.broker.listQueuedForDevice(f.devicePrincipal)).length, 0);
  } finally { await cleanup(f); }
});

test('stale/offline devices reject new calls instead of leaving undispatchable work queued', async () => {
  const f = await fixture();
  try {
    await f.store.transaction((state) => { state.devices[f.deviceId].lastSeen = new Date(Date.now() - 120_000).toISOString(); });
    const projectedRead = (await f.broker.projectedTools(f.operator)).find((t) => t._meta['nymrel/originalToolName'] === 'read_file');
    await assert.rejects(f.broker.createCall(f.operator, projectedRead.name, { path: 'C:/x' }), /offline/);
  } finally { await cleanup(f); }
});
