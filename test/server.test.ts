/**
 * Automated Test Suite: MCP JSON-RPC Server
 * Tests MCP specification handshake, list methods, call methods, and error codes
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCPServer } from '../src/server.js';

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

test('stdio: notification does not corrupt the following request response', async () => {
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
      if (stdout.includes('"id":42')) {
        clearTimeout(timer);
        resolve(null);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/notification' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }) + '\n');
  });

  child.kill();

  const lines = stdout.trim().split('\n').filter((line) => line.trim().length > 0);
  assert.strictEqual(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(lines)}`);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.jsonrpc, '2.0');
  assert.strictEqual(parsed.id, 42);
  assert.deepStrictEqual(parsed.result, {});
  assert.ok(exitCode === null || typeof exitCode === 'number');
});
