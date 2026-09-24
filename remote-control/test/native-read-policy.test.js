import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeLocalClient } from '../src/native-local-client.js';
import { NativeReadPolicy } from '../src/native-read-policy.js';
import { loadNativeLocalOptions } from '../src/native-device-agent.js';

const SECRET = 'SYNTHETIC_CREDENTIAL_MARKER_91d843';
const ORDINARY = 'ordinary studio reference';
const PRIVATE_FILES = [
  '.env', '.env.example', 'config/studio-social.local.env', 'config/service.env.backup',
  'AUTH.JSON', 'device.json', 'credentials.json.backup', 'keys/service.PEM', 'keys/AuthKey_fixture.p8',
  'application_default_credentials.json', 'service-account.json', 'client_secret_fixture.json', '.npmrc',
  '.git/config', '.studio-secrets/provider.key', '.ssh/id_ed25519',
  'private-notes/note.md'
];

async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-read-policy-'));
  const root = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'workspace-sibling');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(root, 'docs', 'ordinary.md'), ORDINARY);
  await fs.writeFile(path.join(sibling, 'outside.md'), SECRET);
  for (const relative of PRIVATE_FILES) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `credential=${SECRET}`);
  }
  const client = new NativeLocalClient({
    allowedDirectories: [root], cwd: root, deniedReadPaths: ['private-notes'], ...options
  });
  await client.start();
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(parent), path.resolve(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith('nymrel-read-policy-'));
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { client, root, sibling };
}

async function denied(client, tool, args, pattern = /native read policy/) {
  await assert.rejects(client.callTool(tool, args), (error) => {
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
}

test('credential paths never reach direct file reads, metadata or multi-read output', async (t) => {
  const { client } = await fixture(t);
  for (const file of PRIVATE_FILES) {
    await denied(client, 'read_file', { path: file });
    await denied(client, 'get_file_info', { path: file });
    await denied(client, 'read_multiple_files', { paths: ['docs/ordinary.md', file] });
  }
  assert.equal((await client.callTool('read_file', { path: 'docs/ordinary.md' })).structuredContent.text, ORDINARY);
  assert.equal((await client.callTool('get_file_info', { path: 'docs/ordinary.md' })).structuredContent.type, 'file');
});

test('directory and recursive searches omit excluded names and credential contents', async (t) => {
  const { client } = await fixture(t);
  for (const [tool, args] of [
    ['list_directory', { path: '.', depth: 8 }],
    ['search_files', { path: '.', pattern: '*', maxDepth: 20 }],
    ['search_content', { path: '.', pattern: 'credential', maxDepth: 20 }]
  ]) {
    const result = await client.callTool(tool, args);
    const output = JSON.stringify(result);
    assert.ok(!output.includes(SECRET), tool);
    const returnedPaths = (result.structuredContent.entries || result.structuredContent.results)
      .map((item) => item.path.replace(/\\/g, '/').toLowerCase());
    for (const file of PRIVATE_FILES) {
      assert.ok(!returnedPaths.some((value) => value === file.toLowerCase() || value.endsWith(`/${file.toLowerCase()}`)), `${tool}: ${file}`);
    }
    assert.ok(!returnedPaths.some((value) => /(?:^|\/)(?:\.git|\.studio-secrets|\.ssh|private-notes)(?:\/|$)/.test(value)));
    if (tool === 'search_content') assert.deepEqual(result.structuredContent.results, []);
    else assert.match(output, /ordinary\.md/);
  }
  const ordinary = await client.callTool('search_content', { path: '.', pattern: 'studio' });
  assert.equal(ordinary.structuredContent.results[0].text, ORDINARY);
  for (const tool of ['list_directory', 'search_files', 'search_content']) {
    await denied(client, tool, { path: 'private-notes', pattern: '*' });
  }
});

test('allowed-root containment still rejects traversal and sibling-prefix paths', async (t) => {
  const { client, root, sibling } = await fixture(t);
  for (const file of ['../workspace-sibling/outside.md', path.join(sibling, 'outside.md')]) {
    await denied(client, 'read_file', { path: file }, /outside allowed directories/);
  }
  if (process.platform === 'win32') {
    const ordinary = await client.callTool('read_file', { path: path.join(root, 'docs', 'ordinary.md').toUpperCase() });
    assert.equal(ordinary.structuredContent.text, ORDINARY);
    await denied(client, 'read_file', { path: path.join(sibling, 'outside.md').toUpperCase() }, /outside allowed directories/);
    await denied(client, 'read_file', { path: path.join(root, 'auth.json').toUpperCase() });
  }
});

test('requested and canonical paths both exclude junction/symlink aliases', async (t) => {
  const { client, root, sibling } = await fixture(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.join(root, 'private-notes'), path.join(root, 'innocent-alias'), linkType);
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'secrets'), linkType);
  await fs.symlink(sibling, path.join(root, 'outside-alias'), linkType);
  await fs.symlink(path.join(root, 'docs'), path.join(root, 'ordinary-alias'), linkType);
  await denied(client, 'read_file', { path: 'innocent-alias/note.md' });
  await denied(client, 'get_file_info', { path: 'innocent-alias' });
  await denied(client, 'read_file', { path: 'secrets/ordinary.md' });
  await denied(client, 'read_file', { path: 'outside-alias/outside.md' }, /outside allowed directories/);
  assert.equal((await client.callTool('read_file', { path: 'ordinary-alias/ordinary.md' })).structuredContent.text, ORDINARY);
  for (const [tool, args] of [
    ['list_directory', { path: '.', depth: 8 }],
    ['search_files', { path: '.', pattern: '*', maxDepth: 20 }],
    ['search_content', { path: '.', pattern: 'credential', maxDepth: 20 }]
  ]) {
    const output = JSON.stringify(await client.callTool(tool, args));
    assert.ok(!output.includes(SECRET));
    assert.ok(!output.includes('innocent-alias'));
    assert.ok(!output.includes('outside-alias'));
    assert.ok(!output.includes('secrets'));
  }
});

test('configured denied-path aliases also exclude their canonical destinations', async (t) => {
  const { root } = await fixture(t);
  const alias = path.join(root, 'private-alias');
  await fs.symlink(path.join(root, 'private-notes'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const client = new NativeLocalClient({ allowedDirectories: [root], cwd: root, deniedReadPaths: [alias] });
  await client.start();
  t.after(() => client.stop());
  await denied(client, 'read_file', { path: 'private-alias/note.md' });
  await denied(client, 'read_file', { path: 'private-notes/note.md' });
});

test('file symlinks cannot relabel sensitive files or sensitive requested filenames', async (t) => {
  const { client, root } = await fixture(t);
  try {
    await fs.symlink(path.join(root, '.env'), path.join(root, 'alias.md'), 'file');
    await fs.symlink(path.join(root, 'docs', 'ordinary.md'), path.join(root, 'token.json'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlinks require Developer Mode or privilege; junction tests still run');
    throw error;
  }
  await denied(client, 'read_file', { path: 'alias.md' });
  await denied(client, 'get_file_info', { path: 'alias.md' });
  await denied(client, 'read_file', { path: 'token.json' });
});

test('Windows alternate data streams cannot bypass file read or metadata policy', { skip: process.platform !== 'win32' }, async (t) => {
  const { client, root } = await fixture(t);
  const stream = path.join(root, 'docs', 'ordinary.md:private');
  await fs.writeFile(stream, SECRET);
  await denied(client, 'read_file', { path: stream });
  await denied(client, 'get_file_info', { path: stream });
  assert.equal((await client.callTool('read_file', { path: 'docs/ordinary.md' })).structuredContent.text, ORDINARY);
});

test('Windows name folding, trailing aliases and explicit exclusions are host-independent', () => {
  const policy = new NativeReadPolicy({ cwd: 'C:\\studio', platform: 'win32', deniedPaths: ['private'] });
  for (const file of ['C:\\studio\\.ENV', 'C:\\studio\\auth.json. ', 'C:/studio/config/app.env',
    'docs\\ordinary.md:private', 'C:\\studio\\ordinary.md::$DATA', '\\\\?\\C:\\studio\\ordinary.md',
    '\\\\.\\C:\\studio\\ordinary.md', 'c:\\STUDIO\\PRIVATE\\note.md', '.env\\..\\ordinary.md']) {
    assert.throws(() => policy.assertReadable(file), /native read policy/, file);
  }
  assert.equal(policy.assertReadable('C:\\STUDIO\\private-sibling\\note.md'), 'C:\\STUDIO\\private-sibling\\note.md');
  assert.equal(policy.assertReadable('docs\\ordinary.md'), 'docs\\ordinary.md');
});

test('read exclusions do not change native write or tool capability permissions', async (t) => {
  const { client, root } = await fixture(t);
  const write = await client.callTool('write_file', { path: '.env', content: 'fixture=first' });
  assert.equal(write.isError, false);
  const edit = await client.callTool('edit_block', { path: '.env', old_string: 'first', new_string: 'second' });
  assert.equal(edit.isError, false);
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'fixture=second');
  const tools = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'start_process' && tool._meta['nymrel/capability'] === 'execute'));
  assert.ok(tools.some((tool) => tool.name === 'write_file' && tool._meta['nymrel/capability'] === 'write'));
  await denied(client, 'read_file', { path: '.env' });
});

test('agent accepts only a valid JSON array of extra denied read paths', () => {
  const key = 'NYMREL_REMOTE_DENIED_READ_PATHS';
  const previous = process.env[key];
  try {
    process.env[key] = '["private-notes"]';
    assert.deepEqual(loadNativeLocalOptions().deniedReadPaths, ['private-notes']);
    for (const value of ['null', '{}', '[""]', '[1]', 'invalid']) {
      process.env[key] = value;
      assert.throws(() => loadNativeLocalOptions(), /JSON string array/);
    }
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});
