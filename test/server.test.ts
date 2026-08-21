/**
 * Automated Test Suite: MCP JSON-RPC Server
 * Tests MCP specification handshake, list methods, call methods, and error codes
 */

import test from 'node:test';
import assert from 'node:assert';
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
