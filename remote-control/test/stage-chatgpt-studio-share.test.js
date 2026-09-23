import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageChatgptStudioShare } from '../scripts/stage-chatgpt-studio-share.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-share-test-'));
  t.after(async () => {
    const canonical = await fs.realpath(root).catch(() => null);
    if (canonical && path.dirname(canonical) === await fs.realpath(os.tmpdir())) {
      await fs.rm(canonical, { recursive: true, force: true });
    }
  });
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'one.md'), '# One\n');
  await fs.writeFile(path.join(source, 'two.txt'), 'Two\n');
  const manifestPath = path.join(root, 'manifest.json');
  const outputDirectory = path.join(root, 'share');
  const writeManifest = (files) => fs.writeFile(manifestPath, JSON.stringify({ version: 1, files }));
  return { root, source, manifestPath, outputDirectory, writeManifest };
}

test('stages only exact reviewed files into a new share with content hashes', async (t) => {
  const f = await fixture(t);
  await f.writeManifest([
    { source: path.join(f.source, 'one.md'), target: 'studio/one.md' },
    { source: path.join(f.source, 'two.txt'), target: 'notes/two.txt' }
  ]);
  const result = await stageChatgptStudioShare(f);
  assert.equal(result.fileCount, 2);
  assert.equal(await fs.readFile(path.join(f.outputDirectory, 'studio', 'one.md'), 'utf8'), '# One\n');
  assert.equal(await fs.readFile(path.join(f.outputDirectory, 'notes', 'two.txt'), 'utf8'), 'Two\n');
  const index = await fs.readFile(path.join(f.outputDirectory, 'INDEX.md'), 'utf8');
  assert.match(index, /studio\/one\.md/);
  assert.match(index, /notes\/two\.txt/);
  assert.doesNotMatch(index, new RegExp(f.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(stageChatgptStudioShare(f), { code: 'OUTPUT_ALREADY_EXISTS' });
});

test('rejects traversal and case-colliding targets before creating a share', async (t) => {
  const f = await fixture(t);
  for (const files of [
    [{ source: path.join(f.source, 'one.md'), target: '../secret.md' }],
    [
      { source: path.join(f.source, 'one.md'), target: 'One.md' },
      { source: path.join(f.source, 'two.txt'), target: 'one.MD' }
    ]
  ]) {
    await f.writeManifest(files);
    await assert.rejects(stageChatgptStudioShare(f));
    await assert.rejects(fs.lstat(f.outputDirectory), { code: 'ENOENT' });
  }
});

test('rejects a source reached through a linked directory', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.writeManifest([{ source: path.join(alias, 'one.md'), target: 'one.md' }]);
  await assert.rejects(stageChatgptStudioShare(f), { code: 'SOURCE_LINK_OR_NOT_FILE' });
  await assert.rejects(fs.lstat(f.outputDirectory), { code: 'ENOENT' });
});

test('rejects a linked output parent before writing any staged files', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'linked-parent');
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await f.writeManifest([{ source: path.join(f.source, 'one.md'), target: 'one.md' }]);
    await assert.rejects(stageChatgptStudioShare({
      manifestPath: f.manifestPath, outputDirectory: path.join(alias, 'share')
    }), { code: 'OUTPUT_PARENT_LINKED' });
    await assert.rejects(fs.lstat(f.outputDirectory), { code: 'ENOENT' });
  } finally {
    await fs.unlink(alias);
  }
});
