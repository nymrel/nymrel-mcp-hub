import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 30_000;
const INHERITED_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'
];

function safeChildEnv(explicit = {}) {
  const env = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (typeof value !== 'string') throw new Error(`Local MCP env ${key} must be a string`);
    env[key] = value;
  }
  env.NYMREL_REMOTE_DEVICE = 'true';
  return env;
}

export class StdioMcpClient extends EventEmitter {
  constructor({ command, args = [], nodeEntry = null, cwd, env = {}, requestTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (!command && !nodeEntry) throw new Error('MCP command or nodeEntry is required');
    this.command = command;
    this.args = [...args];
    this.nodeEntry = nodeEntry;
    this.cwd = cwd;
    this.env = { ...env };
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.stopping = false;
    this.startPromise = null;
    this.generation = 0;
  }

  async start() {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startImpl().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #startImpl() {
    this.stopping = false;
    if (process.platform === 'win32' && !this.nodeEntry && /\.(cmd|bat)$/i.test(String(this.command))) {
      throw new Error('Windows .cmd/.bat MCP launchers require NYMREL_REMOTE_MCP_NODE_ENTRY; shell wrappers are intentionally disabled');
    }
    const executable = this.nodeEntry ? process.execPath : this.command;
    const childArgs = this.nodeEntry ? [this.nodeEntry, ...this.args] : this.args;
    const child = spawn(executable, childArgs, {
      cwd: this.cwd,
      env: safeChildEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    this.process = child;
    this.buffer = '';
    const generation = ++this.generation;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(child, generation, chunk));
    child.stderr.on('data', (chunk) => {
      if (this.process !== child) return;
      this.emit('diagnostic', { type: 'stderr', bytes: Buffer.byteLength(chunk), generation });
    });
    child.on('error', (error) => this.#onDisconnect(child, generation, error));
    child.on('close', (code, signal) => this.#onDisconnect(child, generation, new Error(`Local MCP exited (${code ?? 'null'}/${signal ?? 'none'})`)));

    try {
      await this.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'nymrel-remote-agent', version: '0.1.0' }
      }, this.requestTimeoutMs);
      this.notify('notifications/initialized', {});
      if (this.process !== child) throw new Error('Local MCP generation changed during initialization');
      this.ready = true;
      this.emit('ready', { generation });
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async ensureReady() {
    if (!this.ready || !this.process || this.process.killed) await this.start();
  }

  async listTools({ maxPages = 64, maxTools = 4096 } = {}) {
    await this.ensureReady();
    const tools = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error('Local MCP tools/list returned an invalid tool catalog');
      tools.push(...result.tools);
      if (tools.length > maxTools) throw new Error('Local MCP tool catalog exceeds aggregate limit');
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) return tools;
    }
    throw new Error('Local MCP tool catalog pagination exceeds page limit');
  }

  async callTool(name, args, timeoutMs = this.requestTimeoutMs) {
    await this.ensureReady();
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.process?.stdin || this.process.stdin.destroyed) return Promise.reject(new Error('Local MCP is not connected'));
    const id = this.nextId++;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Local MCP request timed out: ${method}; execution outcome may be unknown`);
        error.code = 'EXECUTION_OUTCOME_UNKNOWN';
        error.generation = generation;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method, generation });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.process?.stdin || this.process.stdin.destroyed) throw new Error('Local MCP stdin is unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(child, generation, chunk) {
    if (this.process !== child || this.generation !== generation) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.#protocolFault(child, generation, new Error('Local MCP emitted invalid JSON on stdout')); return; }
      if (message?.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending || pending.generation !== generation) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `Local MCP ${pending.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else pending.resolve(message.result);
    }
  }

  #protocolFault(child, generation, error) {
    if (this.process !== child || this.generation !== generation) return;
    this.emit('diagnostic', { type: 'protocol_fault', generation });
    this.#rejectPending(error, generation);
    this.ready = false;
    try { child.kill(); } catch { /* best effort */ }
  }

  #onDisconnect(child, generation, error) {
    if (this.process !== child || this.generation !== generation) return;
    const expected = this.stopping;
    this.process = null;
    this.ready = false;
    this.#rejectPending(error, generation);
    if (!expected) this.emit('disconnect', { reason: error.message, generation });
  }

  #rejectPending(error, generation = null) {
    for (const [id, pending] of this.pending.entries()) {
      if (generation !== null && pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async stop() {
    this.stopping = true;
    const child = this.process;
    const generation = this.generation;
    this.process = null;
    this.ready = false;
    this.#rejectPending(new Error('Local MCP stopped'), generation);
    if (!child) return;
    try { child.stdin?.end(); } catch { /* no-op */ }
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* no-op */ }
          resolve();
        }, 2000);
        timer.unref?.();
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}