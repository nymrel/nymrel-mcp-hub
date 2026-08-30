/**
 * Automated Test Suite: MCP JSON-RPC Server
 * Tests MCP specification handshake, list methods, call methods, and error codes
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCPServer } from '../src/server.js';

const MODERN_VERSION = '2026-07-28';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

function modernParams(extra: Record<string, any> = {}): Record<string, any> {
  return {
    ...extra,
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
      [CLIENT_INFO_META_KEY]: { name: 'nymrel-test-client', version: '1.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: {}
    }
  };
}

test('MCP Server: initialize method returns specification compliance', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'claude-code', version: '1.0.0' }
    }
  });

  assert.strictEqual(res?.jsonrpc, '2.0');
  assert.strictEqual(res?.id, 1);
  assert.strictEqual(res?.result?.protocolVersion, '2024-11-05');
  assert.strictEqual(res?.result?.serverInfo?.name, '@nymrel/mcp-hub');
  assert.strictEqual(res?.result?.serverInfo?.version, '1.0.0');
  assert.ok(res?.result?.capabilities?.tools);
  assert.ok(res?.result?.capabilities?.resources);
  assert.ok(res?.result?.capabilities?.prompts);
});

test('MCP Server: initialize negotiates only supported legacy revisions', async () => {
  const server = new MCPServer();
  const latestLegacy = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'legacy-latest',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' }
  });
  assert.strictEqual(latestLegacy?.result?.protocolVersion, '2025-11-25');
  assert.strictEqual(latestLegacy?.result?.resultType, undefined);

  const earliestLegacy = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'legacy-earliest',
    method: 'initialize',
    params: { protocolVersion: '2024-10-07' }
  });
  assert.strictEqual(earliestLegacy?.result?.protocolVersion, '2024-10-07');

  const modernCounterOffer = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'legacy-counter-offer',
    method: 'initialize',
    params: { protocolVersion: MODERN_VERSION }
  });
  assert.strictEqual(modernCounterOffer?.result?.protocolVersion, '2025-11-25');
});

test('MCP Server: server/discover advertises the modern stateless era', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'discover-1',
    method: 'server/discover',
    params: modernParams()
  });

  assert.deepStrictEqual(res?.result?.supportedVersions, [MODERN_VERSION]);
  assert.deepStrictEqual(res?.result?.capabilities, { tools: {}, resources: {}, prompts: {} });
  assert.strictEqual(res?.result?.resultType, 'complete');
  assert.strictEqual(res?.result?.ttlMs, 3_600_000);
  assert.strictEqual(res?.result?.cacheScope, 'public');
  assert.strictEqual(res?.result?._meta?.[SERVER_INFO_META_KEY]?.name, '@nymrel/mcp-hub');
  assert.strictEqual(res?.result?._meta?.[SERVER_INFO_META_KEY]?.version, '1.0.0');
});

test('MCP Server: modern inline requests are validated and result-enveloped', async () => {
  const server = new MCPServer();
  const listRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'modern-tools',
    method: 'tools/list',
    params: modernParams()
  });

  assert.strictEqual(listRes?.result?.tools?.length, 14);
  assert.strictEqual(listRes?.result?.resultType, 'complete');
  assert.strictEqual(listRes?.result?.ttlMs, 300_000);
  assert.strictEqual(listRes?.result?.cacheScope, 'public');
  assert.strictEqual(listRes?.result?._meta?.[SERVER_INFO_META_KEY]?.name, '@nymrel/mcp-hub');

  const callRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'modern-call',
    method: 'tools/call',
    params: modernParams({
      name: 'nymrel_surety_guard',
      arguments: { command: 'git status' }
    })
  });
  assert.strictEqual(callRes?.result?.resultType, 'complete');
  assert.strictEqual(callRes?.result?.ttlMs, undefined);
  assert.strictEqual(callRes?.result?.content?.[0]?.type, 'text');
});

test('MCP Server: modern metadata failures are fail-closed and actionable', async () => {
  const server = new MCPServer();
  const unsupported = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'unsupported-version',
    method: 'tools/list',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2027-01-01',
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  });
  assert.strictEqual(unsupported?.error?.code, -32022);
  assert.deepStrictEqual(unsupported?.error?.data, {
    supported: [MODERN_VERSION],
    requested: '2027-01-01'
  });

  const missingCapabilities = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'missing-capabilities',
    method: 'server/discover',
    params: {
      _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION }
    }
  });
  assert.strictEqual(missingCapabilities?.error?.code, -32602);

  const malformedClientInfo = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'malformed-client-info',
    method: 'server/discover',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
        [CLIENT_INFO_META_KEY]: { name: 'missing-version' }
      }
    }
  });
  assert.strictEqual(malformedClientInfo?.error?.code, -32602);
});

test('MCP Server: ping remains legacy-only in the modern era', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'modern-ping',
    method: 'ping',
    params: modernParams()
  });
  assert.strictEqual(res?.error?.code, -32601);
});

test('MCP Server: ping returns empty object', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 'test-ping-1',
    method: 'ping'
  });

  assert.strictEqual(res?.id, 'test-ping-1');
  assert.deepStrictEqual(res?.result, {});
});

test('MCP Server: tools/list returns all 14 tools', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  });

  assert.strictEqual(res?.id, 2);
  assert.ok(Array.isArray(res?.result?.tools));
  assert.strictEqual(res?.result?.tools?.length, 14);
  assert.strictEqual(res?.result?.resultType, undefined);
});

test('MCP Server: tools/call executes tool and formats content', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'nymrel_surety_guard',
      arguments: {
        command: 'git status'
      }
    }
  });

  assert.strictEqual(res?.id, 3);
  assert.ok(res?.result?.content);
  assert.strictEqual(res?.result?.content[0]?.type, 'text');
  const payload = JSON.parse(res?.result?.content[0]?.text);
  assert.strictEqual(payload.isSafe, true);
});

test('MCP Server: resources/list and resources/read', async () => {
  const server = new MCPServer();
  const listRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'resources/list'
  });

  assert.strictEqual(listRes?.result?.resources?.length, 3);

  const readRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'resources/read',
    params: {
      uri: 'nymrel://status'
    }
  });

  assert.strictEqual(readRes?.result?.contents?.length, 1);
  assert.strictEqual(readRes?.result?.contents[0]?.uri, 'nymrel://status');
  const statusData = JSON.parse(readRes?.result?.contents[0]?.text);
  assert.strictEqual(statusData.server, '@nymrel/mcp-hub');
  assert.strictEqual(statusData.protocolVersions.modern, MODERN_VERSION);
  assert.deepStrictEqual(statusData.protocolVersions.legacy, [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07'
  ]);
});

test('MCP Server: prompts/list and prompts/get', async () => {
  const server = new MCPServer();
  const listRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'prompts/list'
  });

  assert.strictEqual(listRes?.result?.prompts?.length, 3);

  const getRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'prompts/get',
    params: {
      name: 'audit-website-ucp',
      arguments: {
        targetUrl: 'https://nymrel.com'
      }
    }
  });

  assert.ok(getRes?.result?.messages);
  assert.ok(getRes?.result?.messages[0]?.content?.text?.includes('https://nymrel.com'));
});

test('MCP Server: handles unknown methods and errors gracefully', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 99,
    method: 'unknown/method'
  });

  assert.strictEqual(res?.id, 99);
  assert.strictEqual(res?.error?.code, -32601);
});

test('JSON-RPC 2.0: unknown-method notification with no id produces no response', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    method: 'unknown/notification'
  });

  assert.strictEqual(res, null);

  const modernRes = await server.handleRequest({
    jsonrpc: '2.0',
    method: 'unknown/notification',
    params: modernParams()
  });
  assert.strictEqual(modernRes, null);
});

test('MCP Server: notifications/initialized remains silent', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });

  assert.strictEqual(res, null);
});

test('JSON-RPC 2.0: explicit id null is a request, not a notification', async () => {
  const server = new MCPServer();

  const pingRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: null,
    method: 'ping'
  });
  assert.strictEqual(pingRes?.id, null);
  assert.deepStrictEqual(pingRes?.result, {});

  const unknownRes = await server.handleRequest({
    jsonrpc: '2.0',
    id: null,
    method: 'unknown/method'
  });
  assert.strictEqual(unknownRes?.id, null);
  assert.strictEqual(unknownRes?.error?.code, -32601);
});

test('JSON-RPC 2.0: malformed request responds -32600 with id null', async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    jsonrpc: '1.0',
    method: 'ping'
  } as any);

  assert.strictEqual(res?.id, null);
  assert.strictEqual(res?.error?.code, -32600);
});

test('stdio: notifications stay silent and dual-era responses keep their wire shapes', async () => {
  const binPath = fileURLToPath(new URL('../../bin/mcp-server.js', import.meta.url));
  const child = spawn(process.execPath, [binPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for correlated ping response; stderr: ${stderr}`));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"id":41') && stdout.includes('"id":42')) {
        clearTimeout(timer);
        resolve(null);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification' }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'unknown/modern-notification',
      params: modernParams()
    }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/list',
      params: modernParams()
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }) + '\n');
  });

  child.kill();

  const lines = stdout.trim().split('\n').filter((line) => line.trim().length > 0);
  assert.strictEqual(lines.length, 2, `expected exactly two stdout lines, got: ${JSON.stringify(lines)}`);
  const parsed = lines.map((line) => JSON.parse(line));
  const modern = parsed.find((message) => message.id === 41);
  const legacy = parsed.find((message) => message.id === 42);
  assert.strictEqual(modern?.jsonrpc, '2.0');
  assert.strictEqual(modern?.result?.resultType, 'complete');
  assert.strictEqual(modern?.result?._meta?.[SERVER_INFO_META_KEY]?.name, '@nymrel/mcp-hub');
  assert.strictEqual(legacy?.jsonrpc, '2.0');
  assert.deepStrictEqual(legacy?.result, {});
  assert.ok(exitCode === null || typeof exitCode === 'number');
});
