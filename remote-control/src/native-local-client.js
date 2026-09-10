import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

function textResult(value, { isError = false } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: 'text', text }], isError };
  if (value && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

function readTool(name, description, inputSchema) {
  return {
    name, description, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: { 'nymrel/capability': 'read' }
  };
}

function writeTool(name, description, inputSchema, destructive = false) {
  return {
    name, description, inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: destructive },
    _meta: { 'nymrel/capability': 'write', ...(destructive ? { 'nymrel/destructive': true } : {}) }
  };
}

function execTool(name, description, inputSchema, destructive = false) {
  return {
    name, description, inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: destructive },
    _meta: { 'nymrel/capability': 'execute', ...(destructive ? { 'nymrel/destructive': true } : {}) }
  };
}

const pathProp = { type: 'string', minLength: 1, description: 'Absolute path or path relative to the configured working directory.' };

export const NATIVE_TOOLS = Object.freeze([
  readTool('ping', 'Verify the Nymrel native device backend is responsive.', {
    type: 'object', additionalProperties: false, properties: {}
  }),
  readTool('get_config', 'Return non-secret native device execution configuration.', {
    type: 'object', additionalProperties: false, properties: {}
  }),
  readTool('read_file', 'Read a UTF-8 text file with optional line pagination.', {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: pathProp,
      offset: { type: 'integer', default: 0, description: '0-based start line; negative values read from the tail.' },
      length: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 }
    }
  }),
  readTool('read_multiple_files', 'Read several UTF-8 text files in one call.', {
    type: 'object', additionalProperties: false, required: ['paths'],
    properties: {
      paths: { type: 'array', minItems: 1, maxItems: 20, items: pathProp }
    }
  }),
  readTool('list_directory', 'List a directory tree with a bounded recursion depth.', {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: {
      path: pathProp,
      depth: { type: 'integer', minimum: 1, maximum: 8, default: 2 }
    }
  }),
  readTool('get_file_info', 'Return metadata for a file or directory.', {
    type: 'object', additionalProperties: false, required: ['path'], properties: { path: pathProp }
  }),
  readTool('search_files', 'Search file and directory names below an allowed path.', {
    type: 'object', additionalProperties: false, required: ['path', 'pattern'],
    properties: {
      path: pathProp,
      pattern: { type: 'string', minLength: 1, maxLength: 512 },
      ignoreCase: { type: 'boolean', default: true },
      maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
    }
  }),
  readTool('search_content', 'Search UTF-8 file contents below an allowed path.', {
    type: 'object', additionalProperties: false, required: ['path', 'pattern'],
    properties: {
      path: pathProp,
      pattern: { type: 'string', minLength: 1, maxLength: 2048 },
      filePattern: { type: 'string', maxLength: 256 },
      literalSearch: { type: 'boolean', default: true },
      ignoreCase: { type: 'boolean', default: true },
      maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
    }
  }),
  writeTool('write_file', 'Create, replace, or append to a UTF-8 text file.', {
    type: 'object', additionalProperties: false, required: ['path', 'content'],
    properties: {
      path: pathProp,
      content: { type: 'string' },
      mode: { type: 'string', enum: ['rewrite', 'append'], default: 'rewrite' }
    }
  }),
  writeTool('edit_block', 'Replace an exact text block in a UTF-8 file.', {
    type: 'object', additionalProperties: false, required: ['path', 'old_string', 'new_string'],
    properties: {
      path: pathProp,
      old_string: { type: 'string', minLength: 1 },
      new_string: { type: 'string' },
      expected_replacements: { type: 'integer', minimum: 1, maximum: 1000, default: 1 }
    }
  }),
  writeTool('create_directory', 'Create a directory and any missing parents.', {
    type: 'object', additionalProperties: false, required: ['path'], properties: { path: pathProp }
  }),
  writeTool('move_file', 'Move or rename a file or directory within allowed roots.', {
    type: 'object', additionalProperties: false, required: ['source', 'destination'],
    properties: { source: pathProp, destination: pathProp }
  }),
  writeTool('delete_file', 'Delete a file or directory. Recursive directory deletion must be explicit.', {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: pathProp, recursive: { type: 'boolean', default: false } }
  }, true),
  execTool('start_process', 'Start a shell command in an allowed working directory and retain an interactive session.', {
    type: 'object', additionalProperties: false, required: ['command'],
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 32768 },
      cwd: pathProp,
      shell: { type: 'string', minLength: 1, maxLength: 1024 }
    }
  }),
  readTool('read_process_output', 'Read retained stdout/stderr from a Nymrel process session.', {
    type: 'object', additionalProperties: false, required: ['pid'],
    properties: {
      pid: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', default: 0 },
      length: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 }
    }
  }),
  execTool('interact_with_process', 'Write one line to the stdin of a retained process session.', {
    type: 'object', additionalProperties: false, required: ['pid', 'input'],
    properties: {
      pid: { type: 'integer', minimum: 1 },
      input: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 1500 }
    }
  }),
  readTool('list_sessions', 'List process sessions started by this Nymrel native backend.', {
    type: 'object', additionalProperties: false, properties: {}
  }),
  readTool('list_processes', 'List operating-system processes without exposing command-line arguments.', {
    type: 'object', additionalProperties: false, properties: {}
  }),
  execTool('kill_process', 'Terminate a process by PID.', {
    type: 'object', additionalProperties: false, required: ['pid'],
    properties: { pid: { type: 'integer', minimum: 1 } }
  }, true)
]);

function globToRegExp(pattern, ignoreCase = true) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, ignoreCase ? 'i' : '');
}

function lineWindow(text, offset = 0, length = 1000) {
  const lines = String(text).split(/\r?\n/);
  let start = Number(offset) || 0;
  if (start < 0) start = Math.max(0, lines.length + start);
  const end = Math.min(lines.length, start + Math.max(1, Number(length) || 1000));
  return { text: lines.slice(start, end).join('\n'), start, end, totalLines: lines.length };
}

function boundedText(value, maxBytes = MAX_TEXT_BYTES) {
  const buffer = Buffer.from(String(value), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  return buffer.subarray(0, maxBytes).toString('utf8');
}

async function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout));
    });
  });
}

export class NativeLocalClient extends EventEmitter {
  constructor({
    allowedDirectories = [os.homedir()],
    cwd = os.homedir(),
    shell,
    blockedCommands = [],
    maxTextBytes = MAX_TEXT_BYTES
  } = {}) {
    super();
    this.allowedDirectories = [...allowedDirectories];
    this.cwd = path.resolve(cwd);
    this.shell = shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
    this.blockedCommands = blockedCommands.map((value) => new RegExp(value, process.platform === 'win32' ? 'i' : ''));
    this.maxTextBytes = maxTextBytes;
    this.allowedRoots = [];
    this.ready = false;
    this.sessions = new Map();
  }

  async start() {
    if (this.ready) return;
    const roots = [];
    for (const item of this.allowedDirectories) {
      const resolved = path.resolve(item);
      const real = await fs.realpath(resolved).catch(() => null);
      if (!real) throw new Error(`Allowed directory does not exist: ${resolved}`);
      roots.push(path.normalize(real));
    }
    this.allowedRoots = roots;
    this.cwd = await this.#resolveExisting(this.cwd);
    this.ready = true;
    this.emit('ready');
  }

  async stop() {
    this.ready = false;
    const pending = [];
    for (const session of this.sessions.values()) {
      const child = session.child;
      if (child.exitCode !== null || child.killed) continue;
      pending.push(new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          finish();
        }, 2000);
        timer.unref?.();
        child.once('close', finish);
        try { child.kill('SIGTERM'); } catch { finish(); }
      }));
    }
    await Promise.allSettled(pending);
  }

  async ensureReady() {
    if (!this.ready) await this.start();
  }

  async listTools() {
    await this.ensureReady();
    return NATIVE_TOOLS.map((tool) => structuredClone(tool));
  }

  async callTool(name, args = {}) {
    await this.ensureReady();
    try {
      switch (name) {
        case 'ping': return textResult({ ok: true, backend: 'native', platform: process.platform, timestamp: new Date().toISOString() });
        case 'get_config': return textResult(this.#publicConfig());
        case 'read_file': return this.#readFile(args);
        case 'read_multiple_files': return this.#readMultipleFiles(args);
        case 'write_file': return this.#writeFile(args);
        case 'edit_block': return this.#editBlock(args);
        case 'create_directory': return this.#createDirectory(args);
        case 'list_directory': return this.#listDirectory(args);
        case 'move_file': return this.#moveFile(args);
        case 'delete_file': return this.#deleteFile(args);
        case 'get_file_info': return this.#fileInfo(args);
        case 'search_files': return this.#searchFiles(args);
        case 'search_content': return this.#searchContent(args);
        case 'start_process': return this.#startProcess(args);
        case 'read_process_output': return this.#readProcessOutput(args);
        case 'interact_with_process': return this.#interact(args);
        case 'list_sessions': return this.#listSessions();
        case 'list_processes': return this.#listProcesses();
        case 'kill_process': return this.#killProcess(args);
        default: throw new Error(`Unknown native tool: ${name}`);
      }
    } catch (error) {
      return textResult({ error: { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 2000) } }, { isError: true });
    }
  }

  #publicConfig() {
    return {
      backend: 'native',
      platform: process.platform,
      hostname: os.hostname(),
      allowedDirectories: [...this.allowedRoots],
      cwd: this.cwd,
      shell: this.shell,
      blockedCommandRules: this.blockedCommands.length,
      toolCount: NATIVE_TOOLS.length
    };
  }

  #assertAllowed(candidate) {
    const normalized = path.normalize(candidate);
    const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    const target = fold(normalized);
    for (const root of this.allowedRoots) {
      const rootFolded = fold(path.normalize(root));
      const rel = path.relative(rootFolded, target);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return normalized;
    }
    throw new Error(`Path is outside allowed directories: ${candidate}`);
  }

  async #nearestExistingAncestor(candidate) {
    let current = path.resolve(candidate);
    while (true) {
      try {
        return { requestedPath: current, realPath: await fs.realpath(current) };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  async #resolveExisting(input) {
    if (typeof input !== 'string' || input.length === 0) throw new Error('path must be a non-empty string');
    const absolute = path.resolve(this.cwd, input);
    const real = await fs.realpath(absolute);
    return this.#assertAllowed(real);
  }

  async #resolveWritable(input) {
    if (typeof input !== 'string' || input.length === 0) throw new Error('path must be a non-empty string');
    const absolute = path.resolve(this.cwd, input);
    const ancestor = await this.#nearestExistingAncestor(absolute);
    this.#assertAllowed(ancestor.realPath);
    const suffix = path.relative(ancestor.requestedPath, absolute);
    const canonicalTarget = path.resolve(ancestor.realPath, suffix);
    this.#assertAllowed(canonicalTarget);
    return canonicalTarget;
  }

  async #readFile({ path: file, offset = 0, length = 1000 }) {
    const target = await this.#resolveExisting(file);
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('read_file requires a regular file');
      if (stat.size > this.maxTextBytes) throw new Error(`File exceeds ${this.maxTextBytes} byte text-read limit`);
      const content = await handle.readFile({ encoding: 'utf8' });
      const window = lineWindow(content, offset, length);
      return textResult({ path: target, ...window });
    } finally {
      await handle.close();
    }
  }

  async #readMultipleFiles({ paths }) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) throw new Error('paths must contain 1 to 20 items');
    const files = [];
    for (const item of paths) {
      const result = await this.#readFile({ path: item, offset: 0, length: 1000 });
      const payload = result.structuredContent || {};
      files.push(payload);
    }
    return textResult({ files });
  }

  async #writeFile({ path: file, content, mode = 'rewrite' }) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (Buffer.byteLength(content) > this.maxTextBytes) throw new Error(`content exceeds ${this.maxTextBytes} byte write limit`);
    if (!['rewrite', 'append'].includes(mode)) throw new Error('mode must be rewrite or append');
    const target = await this.#resolveWritable(file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (mode === 'append') await fs.appendFile(target, content, 'utf8');
    else await fs.writeFile(target, content, 'utf8');
    const stat = await fs.stat(target);
    return textResult({ path: target, bytes: stat.size, mode });
  }

  async #editBlock({ path: file, old_string, new_string, expected_replacements = 1 }) {
    const target = await this.#resolveExisting(file);
    if (typeof old_string !== 'string' || old_string.length === 0 || typeof new_string !== 'string') throw new Error('old_string and new_string must be strings');
    const content = await fs.readFile(target, 'utf8');
    let count = 0;
    let cursor = 0;
    while ((cursor = content.indexOf(old_string, cursor)) !== -1) {
      count += 1;
      cursor += old_string.length;
    }
    if (count !== expected_replacements) throw new Error(`Expected ${expected_replacements} replacement(s), found ${count}`);
    const replaced = content.split(old_string).join(new_string);
    if (Buffer.byteLength(replaced) > this.maxTextBytes) throw new Error('Edited file exceeds text-write limit');
    await fs.writeFile(target, replaced, 'utf8');
    return textResult({ path: target, replacements: count });
  }

  async #createDirectory({ path: dir }) {
    const target = await this.#resolveWritable(dir);
    await fs.mkdir(target, { recursive: true });
    return textResult({ path: target, created: true });
  }

  async #listDirectory({ path: dir, depth = 2 }) {
    const root = await this.#resolveExisting(dir);
    const entries = [];
    const walk = async (current, level) => {
      if (entries.length >= 2000 || level > depth) return;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entries.length >= 2000) break;
        const full = path.join(current, entry.name);
        const relative = path.relative(root, full) || '.';
        entries.push({ path: relative, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' });
        if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      }
    };
    await walk(root, 1);
    return textResult({ root, entries, truncated: entries.length >= 2000 });
  }

  async #moveFile({ source, destination }) {
    const src = await this.#resolveExisting(source);
    const dst = await this.#resolveWritable(destination);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return textResult({ source: src, destination: dst });
  }

  async #deleteFile({ path: targetPath, recursive = false }) {
    const target = await this.#resolveExisting(targetPath);
    if (this.allowedRoots.some((root) => path.normalize(root) === path.normalize(target))) throw new Error('Refusing to delete an allowed-directory root');
    const stat = await fs.stat(target);
    if (stat.isDirectory() && !recursive) throw new Error('Directory deletion requires recursive=true');
    await fs.rm(target, { recursive: Boolean(recursive), force: false });
    return textResult({ path: target, deleted: true });
  }

  async #fileInfo({ path: targetPath }) {
    const target = await this.#resolveExisting(targetPath);
    const stat = await fs.stat(target);
    let lineCount = null;
    let handle;
    try {
      handle = await fs.open(target, 'r');
      const openedStat = await handle.stat();
      if (openedStat.isFile() && openedStat.size <= this.maxTextBytes) {
        lineCount = (await handle.readFile({ encoding: 'utf8' })).split(/\r?\n/).length;
      }
    } catch {
      lineCount = null;
    } finally {
      await handle?.close().catch(() => {});
    }
    return textResult({
      path: target,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      mode: stat.mode,
      lineCount
    });
  }

  async #searchFiles({ path: rootPath, pattern, ignoreCase = true, maxResults = 100, maxDepth = 10 }) {
    const root = await this.#resolveExisting(rootPath);
    const matcher = globToRegExp(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`, ignoreCase);
    const results = [];
    await this.#walkSearch(root, maxDepth, async (full, entry) => {
      if (matcher.test(entry.name)) results.push({ path: full, type: entry.isDirectory() ? 'directory' : 'file' });
      return results.length < maxResults;
    });
    return textResult({ root, pattern, results, truncated: results.length >= maxResults });
  }

  async #searchContent({ path: rootPath, pattern, filePattern, literalSearch = true, ignoreCase = true, maxResults = 100, maxDepth = 10 }) {
    const root = await this.#resolveExisting(rootPath);
    const fileMatcher = filePattern ? globToRegExp(filePattern, ignoreCase) : null;
    const flags = ignoreCase ? 'i' : '';
    const matcher = literalSearch ? null : new RegExp(pattern, flags);
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    const results = [];
    await this.#walkSearch(root, maxDepth, async (full, entry) => {
      if (!entry.isFile() || (fileMatcher && !fileMatcher.test(entry.name))) return true;
      let handle;
      let text;
      try {
        handle = await fs.open(full, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.maxTextBytes) return true;
        text = await handle.readFile({ encoding: 'utf8' });
      } catch {
        return true;
      } finally {
        await handle?.close().catch(() => {});
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
        const haystack = ignoreCase ? lines[i].toLowerCase() : lines[i];
        const matched = literalSearch ? haystack.includes(needle) : matcher.test(lines[i]);
        if (matched) results.push({ path: full, line: i + 1, text: boundedText(lines[i], 2000) });
      }
      return results.length < maxResults;
    });
    return textResult({ root, pattern, results, truncated: results.length >= maxResults });
  }

  async #walkSearch(root, maxDepth, visitor) {
    const walk = async (current, depth) => {
      if (depth > maxDepth) return true;
      let entries;
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return true; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        const keepGoing = await visitor(full, entry);
        if (!keepGoing) return false;
        if (entry.isDirectory()) {
          const continued = await walk(full, depth + 1);
          if (!continued) return false;
        }
      }
      return true;
    };
    await walk(root, 1);
  }

  #assertCommandAllowed(command) {
    if (this.blockedCommands.some((rule) => rule.test(command))) throw new Error('Command blocked by native device policy');
  }

  async #startProcess({ command, cwd = this.cwd, shell = this.shell }) {
    if (typeof command !== 'string' || command.trim().length === 0) throw new Error('command must be a non-empty string');
    this.#assertCommandAllowed(command);
    const workingDirectory = await this.#resolveExisting(cwd);
    const child = spawn(command, {
      cwd: workingDirectory,
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NYMREL_REMOTE_DEVICE: 'true', NYMREL_REMOTE_NATIVE_BACKEND: 'true' }
    });
    const session = {
      id: randomUUID(),
      child,
      commandStartedAt: new Date().toISOString(),
      cwd: workingDirectory,
      output: '',
      readCursor: 0,
      state: 'running',
      exitCode: null,
      signal: null
    };
    const append = (chunk) => {
      session.output += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(session.output) > MAX_PROCESS_OUTPUT_BYTES) {
        session.output = Buffer.from(session.output).subarray(-MAX_PROCESS_OUTPUT_BYTES).toString('utf8');
        session.readCursor = 0;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      session.state = 'error';
      append(`\n[nymrel process error: ${error.message}]\n`);
    });
    child.on('close', (code, signalName) => {
      session.state = 'finished';
      session.exitCode = code;
      session.signal = signalName;
    });
    this.sessions.set(child.pid, session);
    return textResult({ pid: child.pid, sessionId: session.id, state: session.state, cwd: session.cwd });
  }

  #sessionFor(pid) {
    const session = this.sessions.get(Number(pid));
    if (!session) throw new Error(`Unknown Nymrel process session: ${pid}`);
    return session;
  }

  async #readProcessOutput({ pid, offset = 0, length = 1000 }) {
    const session = this.#sessionFor(pid);
    const lines = session.output.split(/\r?\n/);
    let start;
    if (offset === 0) start = session.readCursor;
    else if (offset < 0) start = Math.max(0, lines.length + offset);
    else start = offset;
    const end = Math.min(lines.length, start + length);
    if (offset === 0) session.readCursor = end;
    return textResult({
      pid: Number(pid),
      state: session.state,
      exitCode: session.exitCode,
      signal: session.signal,
      start,
      end,
      totalLines: lines.length,
      output: lines.slice(start, end).join('\n')
    });
  }

  async #interact({ pid, input, timeout_ms = 1500 }) {
    const session = this.#sessionFor(pid);
    if (session.state !== 'running' || session.child.stdin.destroyed) throw new Error('Process is not accepting input');
    const before = session.output.length;
    session.child.stdin.write(`${input}\n`);
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline && session.output.length === before && session.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.#readProcessOutput({ pid, offset: 0, length: 1000 });
  }

  #listSessions() {
    const sessions = [...this.sessions.entries()].map(([pid, session]) => ({
      pid,
      sessionId: session.id,
      state: session.state,
      exitCode: session.exitCode,
      cwd: session.cwd,
      startedAt: session.commandStartedAt
    }));
    return textResult({ sessions });
  }

  async #listProcesses() {
    const output = process.platform === 'win32'
      ? await execFileText('tasklist.exe', ['/FO', 'CSV', '/NH'])
      : await execFileText('ps', ['-eo', 'pid=,comm=,%cpu=,%mem=']);
    return textResult({ platform: process.platform, output: boundedText(output, this.maxTextBytes) });
  }

  async #killProcess({ pid }) {
    const numericPid = Number(pid);
    const session = this.sessions.get(numericPid);
    if (session?.child && session.child.exitCode === null) {
      session.child.kill('SIGTERM');
      return textResult({ pid: numericPid, terminated: true, managedSession: true });
    }
    process.kill(numericPid, 'SIGTERM');
    return textResult({ pid: numericPid, terminated: true, managedSession: false });
  }
}
