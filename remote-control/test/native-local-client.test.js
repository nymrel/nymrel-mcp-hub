import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeLocalClient } from '../src/native-local-client.js';

async function withClient(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-native-'));
  const client = new NativeLocalClient({
    allowedDirectories: [root],
    cwd: root,
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  });
  await client.start();
  try { await run(client, root); } finally {
    await client.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('native backend performs bounded file operations without a local MCP dependency', async () => {
  await withClient(async (client, root) => {
    const tools = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'read_file'));
    assert.ok(tools.some((tool) => tool.name === 'start_process'));

    const wrote = await client.callTool('write_file', { path: 'notes/a.txt', content: 'alpha\nbeta\n' });
    assert.equal(wrote.isError, false);
    assert.equal(wrote.structuredContent.mode, 'rewrite');

    const read = await client.callTool('read_file', { path: 'notes/a.txt', offset: 1, length: 1 });
    assert.equal(read.structuredContent.text, 'beta');

    const edited = await client.callTool('edit_block', {
      path: 'notes/a.txt', old_string: 'beta', new_string: 'gamma', expected_replacements: 1
    });
    assert.equal(edited.structuredContent.replacements, 1);

    const searched = await client.callTool('search_content', { path: root, pattern: 'gamma' });
    assert.equal(searched.structuredContent.results.length, 1);

    await assert.rejects(
      client.callTool('read_file', { path: path.dirname(root) }),
      /outside allowed directories/i
    );
  });
});

test('native backend retains process output in a managed session', async () => {
  await withClient(async (client) => {
    const command = `${JSON.stringify(process.execPath)} -e "console.log('native-ok')"`;
    const started = await client.callTool('start_process', { command });
    assert.equal(started.isError, false);
    const pid = started.structuredContent.pid;

    let output = '';
    for (let attempt = 0; attempt < 40 && !output.includes('native-ok'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const read = await client.callTool('read_process_output', { pid, offset: -20, length: 20 });
      output = read.structuredContent.output;
    }
    assert.match(output, /native-ok/);

    const sessions = await client.callTool('list_sessions', {});
    assert.ok(sessions.structuredContent.sessions.some((session) => session.pid === pid));
  });
});
