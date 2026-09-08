import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../src/stdio-mcp-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('stdio MCP bridge initializes, reflects tools, and executes without a shell wrapper', async () => {
  const client = new StdioMcpClient({ command: process.execPath, args: [path.join(here, '../fixtures/mock-mcp.js')], requestTimeoutMs: 3000 });
  try {
    await client.start();
    const tools = await client.listTools();
    assert.equal(tools[0].name, 'read_file');
    assert.equal(tools[0].inputSchema.properties.path.type, 'string');
    const result = await client.callTool('read_file', { path: '/tmp/a' });
    assert.equal(result.content[0].text, 'read:/tmp/a');
  } finally {
    await client.stop();
  }
});
