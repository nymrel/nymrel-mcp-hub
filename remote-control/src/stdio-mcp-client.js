import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 30_000;

export class StdioMcpClient extends EventEmitter {
  constructor({ command, args = [], cwd, env = {}, requestTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (!command) throw new Error('MCP command is required');
    this.command = command;
    this.args = [...args];
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
  }

  async start() {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startImpl().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #startImpl() {
    this.stopping = false;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, NYMREL_REMOTE_DEVICE: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    this.process = child;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      // Do not forward local MCP stderr text; it may contain paths or user data.
      this.emit('diagnostic', { type: 'stderr', bytes: Buffer.byteLength(chunk) });
    });
    child.on('error', (error) => this.#onDisconnect(error));
    child.on('close', (code, signal) => this.#onDisconnect(new Error(`Local MCP exited (${code ?? 'null'}/${signal ?? 'none'})`)));

    try {
      await this.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'nymrel-remote-agent', version: '0.1.0' }
      }, this.requestTimeoutMs);
      this.notify('notifications/initialized', {});
      this.ready = true;
      this.emit('ready');
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async ensureReady() {
    if (!this.ready || !this.process || this.process.killed) await this.start();
  }

  async listTools() {
    await this.ensureReady();
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local MCP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
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
    // MCP stdio uses one JSON-RPC message per line. Arguments are written only to
    // the local child process; this module never logs or emits them.
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#protocolFault(new Error('Local MCP emitted invalid JSON on stdout'));
        return;
      }
      if (message?.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const err = new Error(message.error.message || `Local MCP ${pending.method} failed`);
        err.code = message.error.code;
        err.data = message.error.data;
        pending.reject(err);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #protocolFault(error) {
    this.emit('diagnostic', { type: 'protocol_fault' });
    this.#rejectPending(error);
    this.ready = false;
    try { this.process?.kill(); } catch { /* best effort */ }
  }

  #onDisconnect(error) {
    if (this.process === null && !this.ready) return;
    const expected = this.stopping;
    this.process = null;
    this.ready = false;
    this.#rejectPending(error);
    if (!expected) this.emit('disconnect', { reason: error.message });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop() {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    this.ready = false;
    this.#rejectPending(new Error('Local MCP stopped'));
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
