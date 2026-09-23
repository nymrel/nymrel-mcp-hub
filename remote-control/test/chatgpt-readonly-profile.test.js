import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHATGPT_READONLY_SCOPES,
  CHATGPT_READONLY_TOOL_NAMES,
  CHATGPT_READONLY_TOOLS,
  ChatgptReadonlyMcpEdge
} from '../src/chatgpt-readonly-profile.js';

test('regular ChatGPT read-only profile exposes only local discovery and file-inspection tools', () => {
  assert.deepEqual(CHATGPT_READONLY_SCOPES, ['devices:read', 'tools:read']);
  assert.deepEqual(CHATGPT_READONLY_TOOL_NAMES, [
    'list_devices',
    'read_file',
    'list_directory',
    'get_file_info',
    'search_files',
    'search_content',
    'get_read_result'
  ]);
  assert.deepEqual(CHATGPT_READONLY_TOOLS.map((tool) => tool.name), CHATGPT_READONLY_TOOL_NAMES);

  for (const tool of CHATGPT_READONLY_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must remain read-only`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} must remain closed-world`);
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} must remain non-destructive`);
  }
});
test('read-only profile preserves native schemas and rejects mutation or execution tools before dispatch', async () => {
  const read = CHATGPT_READONLY_TOOLS.find((tool) => tool.name === 'read_file');
  assert.ok(read.inputSchema.properties.device);
  assert.ok(read.inputSchema.required.includes('path'));

  const broker = new Proxy({}, {
    get() {
      return async () => { throw new Error('broker must not be touched for excluded tools'); };
    }
  });
  const edge = new ChatgptReadonlyMcpEdge({ broker, syncWaitMs: 0 });

  for (const excluded of [
    'write_file',
    'edit_block',
    'start_process',
    'read_process_output',
    'interact_with_process',
    'list_sessions',
    'list_processes',
    'kill_process'
  ]) {
    assert.equal(edge.schemaForTool(excluded), null, `${excluded} schema must not be exposed`);
    await assert.rejects(
      edge.callTool({ scopes: CHATGPT_READONLY_SCOPES }, excluded, {}),
      /read-only ChatGPT tool not found/
    );
  }
});
test('read-only profile still dispatches an allowed file read through the projected JalenPC tool', async () => {
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
      return { id: 'call_1', status: 'completed', result: { content: [{ type: 'text', text: 'readonly-ok' }] } };
    }
  };
  const edge = new ChatgptReadonlyMcpEdge({ broker, syncWaitMs: 0 });
  const result = await edge.callTool({ scopes: CHATGPT_READONLY_SCOPES }, 'read_file', {
    device: 'JalenPC', path: 'notes/a.txt'
  });
  assert.equal(result.content[0].text, 'readonly-ok');
  assert.deepEqual(created, {
    projectedName: 'remote_jalenpc_deadbeef__read_file',
    args: { path: 'notes/a.txt' }
  });
});
