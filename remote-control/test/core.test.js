import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvelopeCipher, randomCode, sha256 } from '../src/crypto.js';
import { TokenService } from '../src/token.js';
import { AuditLedger } from '../src/audit.js';
import { JsonFileStore } from '../src/store.js';
import { collectMcpHeaderBindings, normalizeToolCatalog, projectDeviceTool, schemasEqualProjected } from '../src/schema.js';
import { PolicyEngine } from '../src/policy.js';
import { normalizeAgentServerUrl } from '../src/config.js';

const key = Buffer.alloc(32, 7);

test('internal tokens are signed, scoped, expiring, and tamper evident', () => {
  const service = new TokenService(key);
  const token = service.mint({ subject: 'alice', tenantId: 'acme', scopes: ['tools:read'], now: 1_000_000, ttlSec: 60 });
  const claims = service.verify(token, { requiredScopes: ['tools:read'], now: 1_010_000 });
  assert.equal(claims.sub, 'alice');
  assert.equal(claims.tenant, 'acme');
  assert.throws(() => service.verify(token, { requiredScopes: ['tools:write'], now: 1_010_000 }), /Missing required scope/);
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => service.verify(tampered, { now: 1_010_000 }), /signature/);
  assert.throws(() => service.verify(token, { now: 2_000_000 }), /expired/);
});

test('AES-GCM envelopes bind ciphertext to call-specific AAD', () => {
  const cipher = new EnvelopeCipher(key);
  const envelope = cipher.seal({ secret: 'never-plaintext-at-rest' }, 'call-1:args');
  assert.deepEqual(cipher.open(envelope, 'call-1:args'), { secret: 'never-plaintext-at-rest' });
  assert.throws(() => cipher.open(envelope, 'call-2:args'));
  const replacement = envelope.ciphertext.endsWith('A') ? 'B' : 'A';
  const modified = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${replacement}` };
  assert.throws(() => cipher.open(modified, 'call-1:args'));
});

test('audit chain detects mutation and stores hashes rather than metadata bodies', () => {
  const ledger = new AuditLedger(key);
  const state = { receipts: [] };
  ledger.append(state, { event: 'call.created', argsHash: sha256({ password: 'do-not-store' }), metadata: { private: 'never-store-this' } });
  ledger.append(state, { event: 'call.completed', resultHash: sha256({ answer: 'private-result' }) });
  assert.equal(ledger.verify(state.receipts).valid, true);
  const serialized = JSON.stringify(state.receipts);
  assert.equal(serialized.includes('never-store-this'), false);
  assert.equal(serialized.includes('private-result'), false);
  state.receipts[0].status = 'changed';
  assert.equal(ledger.verify(state.receipts).valid, false);
});

test('projected tools preserve the exact edit_block input schema', () => {
  const source = {
    name: 'edit_block',
    description: 'Edit a block',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        expected_replacements: { type: 'integer', default: 1 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  };
  const normalized = normalizeToolCatalog([source]).tools[0];
  const device = { id: 'dev_123', name: 'JalenPC', status: 'online' };
  const projected = projectDeviceTool(device, normalized);
  assert.deepEqual(projected.inputSchema, source.inputSchema);
  assert.equal(projected.inputSchema.properties.file_path.type, 'string');
  assert.equal(schemasEqualProjected(normalized, projected), true);
  assert.notEqual(projected.inputSchema, normalized.inputSchema);
});

test('x-mcp-header bindings are restricted to statically reachable primitive properties', () => {
  const schema = {
    type: 'object',
    properties: {
      workspace: { type: 'string', 'x-mcp-header': 'Workspace' },
      nested: { type: 'object', properties: { dryRun: { type: 'boolean', 'x-mcp-header': 'Dry-Run' } } }
    }
  };
  assert.deepEqual(collectMcpHeaderBindings(schema), [
    { headerName: 'Workspace', path: ['workspace'], type: 'string' },
    { headerName: 'Dry-Run', path: ['nested', 'dryRun'], type: 'boolean' }
  ]);
  assert.throws(() => collectMcpHeaderBindings({ type: 'object', oneOf: [{ type: 'object', properties: { x: { type: 'string', 'x-mcp-header': 'X' } } }] }), /statically reachable/);
  assert.throws(() => collectMcpHeaderBindings({ type: 'object', properties: { x: { type: 'object', 'x-mcp-header': 'X' } } }), /primitive/);
});

test('policy defaults auto-read, gates writes/execute, and denies unknown/destructive actions', () => {
  const policy = new PolicyEngine();
  const principal = { scopes: ['tools:read', 'tools:write', 'tools:execute', 'tools:unknown'] };
  assert.equal(policy.evaluate(principal, { name: 'read_file' }).decision, 'auto');
  assert.equal(policy.evaluate(principal, { name: 'write_file' }).decision, 'operator');
  assert.equal(policy.evaluate(principal, { name: 'start_process' }).decision, 'operator');
  assert.equal(policy.evaluate({ scopes: ['tools:network'] }, { name: 'read_file' }, { isUrl: true, path: 'https://example.com' }).decision, 'operator');
  assert.equal(policy.evaluate({ scopes: ['tools:network'] }, { name: 'fetch_url' }, { url: 'https://example.com' }).decision, 'operator');
  assert.equal(policy.evaluate(principal, { name: 'mystery' }).decision, 'deny');
  assert.equal(policy.evaluate({ scopes: ['tools:execute', 'tools:dangerous'] }, { name: 'shutdown' }).decision, 'deny');
});

test('file store serializes concurrent transactions and keeps valid JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-store-'));
  const store = await new JsonFileStore(path.join(dir, 'state.json')).init();
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.transaction((state) => { state.devices[`d${i}`] = { i }; })));
  const state = await store.read();
  assert.equal(Object.keys(state.devices).length, 25);
  assert.equal(state.revision, 25);
  await fs.rm(dir, { recursive: true, force: true });
});

test('pairing codes use the approved alphabet without modulo-derived bytes', () => {
  const alphabet = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;
  assert.match(randomCode(256), alphabet);
});

test('agent server URLs are canonical origins with no embedded routing authority', () => {
  assert.equal(normalizeAgentServerUrl('https://remote.example.com/'), 'https://remote.example.com');
  assert.throws(() => normalizeAgentServerUrl('https://user:pass@remote.example.com/'), /origin/);
  assert.throws(() => normalizeAgentServerUrl('https://remote.example.com/api'), /origin/);
  assert.throws(() => normalizeAgentServerUrl('http://remote.example.com/'), /HTTPS/);
});
