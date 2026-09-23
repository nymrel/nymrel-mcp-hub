import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 64;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function samePath(a, b) {
  const normalize = (value) => process.platform === 'win32'
    ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(a) === normalize(b);
}

async function requireUnlinkedFile(filename, maxBytes) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
      filename.startsWith('\\\\') || filename.startsWith('//')) fail('SOURCE_MUST_BE_LOCAL_ABSOLUTE_FILE');
  const resolved = path.resolve(filename);
  const [item, canonical] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
  if (!item.isFile() || !samePath(resolved, canonical)) fail('SOURCE_LINK_OR_NOT_FILE');
  if (item.size > maxBytes) fail('SOURCE_TOO_LARGE');
  return resolved;
}

function validateTarget(target) {
  if (typeof target !== 'string' || target.length > 240 || !/\.(?:md|txt)$/i.test(target) ||
      target.includes('\\') || target.startsWith('/') || target.endsWith('/')) fail('INVALID_TARGET');
  const parts = target.split('/');
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/.test(part) ||
      part.endsWith('.') || part.endsWith(' ') || WINDOWS_DEVICE.test(part) || part === '..')) fail('INVALID_TARGET');
  if (target.toLowerCase() === 'index.md') fail('RESERVED_TARGET');
  return parts;
}

/** Stage only the exact text files named in a reviewed manifest into a new root. */
export async function stageChatgptStudioShare({ manifestPath, outputDirectory }) {
  const manifestFile = await requireUnlinkedFile(manifestPath, MAX_MANIFEST_BYTES);
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory) ||
      outputDirectory.startsWith('\\\\') || outputDirectory.startsWith('//')) fail('OUTPUT_MUST_BE_LOCAL_ABSOLUTE_DIRECTORY');
  const output = path.resolve(outputDirectory);
  const parent = path.dirname(output);
  if (!samePath(parent, await fs.realpath(parent))) fail('OUTPUT_PARENT_LINKED');
  if (await fs.lstat(output).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) fail('OUTPUT_ALREADY_EXISTS');

  const raw = await fs.readFile(manifestFile, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('INVALID_MANIFEST'); }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) ||
      manifest.files.length < 1 || manifest.files.length > MAX_FILES) fail('INVALID_MANIFEST');

  const entries = [];
  const targets = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const parts = validateTarget(entry?.target);
    const key = entry.target.toLowerCase();
    if (targets.has(key)) fail('DUPLICATE_TARGET');
    targets.add(key);
    const source = await requireUnlinkedFile(entry?.source, MAX_FILE_BYTES);
    const bytes = await fs.readFile(source);
    if (bytes.length > MAX_FILE_BYTES) fail('SOURCE_TOO_LARGE');
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('SHARE_TOO_LARGE');
    entries.push({ parts, target: entry.target, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }

  const staging = path.join(parent, `${path.basename(output)}.staging.${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const destination = path.join(staging, ...entry.parts);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
    }
    const index = [
      '# ChatGPTStudio file share',
      '',
      'This folder contains only the exact files staged for review. Check every file before pairing this root.',
      '',
      '| File | Bytes | SHA-256 |',
      '| --- | ---: | --- |',
      ...entries.map((entry) => `| ${entry.target} | ${entry.bytes.length} | ${entry.sha256} |`),
      ''
    ].join('\n');
    await fs.writeFile(path.join(staging, 'INDEX.md'), index, { flag: 'wx', mode: 0o600 });
    await fs.rename(staging, output);
  } catch (error) {
    // This exact temporary directory was created above, below the verified parent.
    if (samePath(path.dirname(staging), parent) &&
        path.basename(staging).startsWith(`${path.basename(output)}.staging.`)) {
      await fs.rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
  return { outputDirectory: output, fileCount: entries.length };
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output') {
    process.stderr.write('Usage: node stage-chatgpt-studio-share.mjs --manifest <absolute-json-path> --output <new-absolute-directory>\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await stageChatgptStudioShare({ manifestPath: args[1], outputDirectory: args[3] });
      process.stdout.write(`NYMREL_CHATGPT_SHARE_READY=${result.outputDirectory}\nNYMREL_CHATGPT_SHARE_FILES=${result.fileCount}\n`);
    } catch (error) {
      process.stderr.write(`NYMREL_CHATGPT_SHARE_FAILED=${error?.code ?? 'UNEXPECTED_ERROR'}\n`);
      process.exitCode = 1;
    }
  }
}
