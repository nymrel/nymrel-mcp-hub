import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeToolCatalog } from './schema.js';
import { StdioMcpClient } from './stdio-mcp-client.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(baseUrl, route, { method = 'GET', token, body, timeoutMs = 30_000, signal } = {}) {
  const controller = signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? controller.signal
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 500) }; }
    }
    if (!response.ok) {
      const error = new Error(parsed?.error?.message || parsed?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = parsed?.error?.code;
      throw error;
    }
    return parsed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readCredentials(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (typeof raw.deviceId === 'string' && typeof raw.token === 'string' && typeof raw.serverUrl === 'string') return raw;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return null;
}

async function writeCredentials(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
}

async function removeCredentials(file) {
  await fs.rm(file, { force: true });
}

function internalTokenExpMs(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== 'nr1') return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export class DeviceAgent {
  constructor(config, { logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.client = new StdioMcpClient({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.mcpCwd,
      requestTimeoutMs: config.callTimeoutMs
    });
    this.credentials = null;
    this.catalog = new Map();
    this.catalogHash = null;
    this.running = false;
    this.reconcilePromise = null;
    this.eventAbort = null;
    this.heartbeatTimer = null;
    this.seen = new Set();
    this.client.on('disconnect', () => {
      this.logger.warn('Local MCP disconnected; the agent will reconnect before the next registration or call.');
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.client.start();
    this.credentials = await readCredentials(this.config.tokenFile);
    if (this.credentials && this.credentials.serverUrl !== this.config.serverUrl) {
      throw new Error(`Stored device credentials belong to ${this.credentials.serverUrl}; refusing to send them to ${this.config.serverUrl}`);
    }
    if (this.credentials && internalTokenExpMs(this.credentials.token) <= Date.now()) {
      await removeCredentials(this.config.tokenFile);
      this.credentials = null;
    }
    if (!this.credentials) await this.#pair();
    await this.#refreshDeviceTokenIfNeeded();
    await this.#register(true);
    await this.reconcile();
    this.#scheduleHeartbeat();
    void this.#eventLoop();
  }

  async stop() {
    this.running = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.eventAbort?.abort();
    await this.client.stop();
  }

  async #pair() {
    const started = await fetchJson(this.config.serverUrl, '/v1/pairings/start', {
      method: 'POST', body: { deviceName: this.config.deviceName, platform: this.config.platform }
    });
    this.logger.log(`Pair this device with code: ${started.user_code}`);
    this.logger.log('Approve the code from an authenticated Nymrel Remote operator session.');
    const deadline = Date.now() + started.expires_in * 1000;
    while (this.running && Date.now() < deadline) {
      await sleep(Math.max(1000, Number(started.interval ?? 3) * 1000));
      let polled;
      try {
        polled = await fetchJson(this.config.serverUrl, '/v1/pairings/poll', {
          method: 'POST', body: { device_code: started.device_code }
        });
      } catch (error) {
        if (error.status >= 500) continue;
        throw error;
      }
      if (polled.status === 'pending') continue;
      if (polled.status !== 'approved') throw new Error(`Pairing ${polled.status}`);
      this.credentials = { deviceId: polled.device_id, token: polled.device_token, serverUrl: this.config.serverUrl };
      await writeCredentials(this.config.tokenFile, this.credentials);
      this.logger.log(`Device paired: ${polled.device_id}`);
      return;
    }
    throw new Error('Device pairing timed out');
  }

  async #refreshDeviceTokenIfNeeded() {
    const expiresAt = internalTokenExpMs(this.credentials?.token);
    if (!expiresAt || expiresAt - Date.now() > 7 * 24 * 60 * 60 * 1000) return;
    const refreshed = await fetchJson(this.config.serverUrl, '/v1/device/token/refresh', {
      method: 'POST', token: this.credentials.token, body: {}
    });
    this.credentials = {
      deviceId: refreshed.device_id,
      token: refreshed.device_token,
      serverUrl: this.config.serverUrl
    };
    await writeCredentials(this.config.tokenFile, this.credentials);
  }

  async #refreshCatalog() {
    await this.client.ensureReady();
    const source = await this.client.listTools();
    const normalized = normalizeToolCatalog(source);
    this.catalog = new Map(normalized.tools.map((tool) => [tool.name, tool]));
    return normalized;
  }

  async #register(force = false) {
    const normalized = await this.#refreshCatalog();
    if (!force && this.catalogHash === normalized.hash) return;
    const registered = await fetchJson(this.config.serverUrl, '/v1/device/register', {
      method: 'POST', token: this.credentials.token,
      body: { deviceName: this.config.deviceName, platform: this.config.platform, tools: normalized.tools, mcpReady: true }
    });
    this.catalogHash = registered.toolCatalogHash;
  }

  #scheduleHeartbeat() {
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.#refreshDeviceTokenIfNeeded();
        await this.#register(false);
        await fetchJson(this.config.serverUrl, '/v1/device/heartbeat', {
          method: 'POST', token: this.credentials.token,
          body: { mcpReady: this.client.ready, toolCatalogHash: this.catalogHash }
        });
        await this.reconcile();
      } catch (error) {
        this.logger.warn(`Heartbeat/reconciliation failed: ${error.message}`);
      } finally {
        if (this.running) {
          this.heartbeatTimer = setTimeout(tick, this.config.heartbeatMs);
          this.heartbeatTimer.unref?.();
        }
      }
    };
    this.heartbeatTimer = setTimeout(tick, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async #eventLoop() {
    let backoff = 1000;
    while (this.running) {
      this.eventAbort = new AbortController();
      try {
        const response = await fetch(`${this.config.serverUrl}/v1/device/events`, {
          headers: { authorization: `Bearer ${this.credentials.token}`, accept: 'text/event-stream' },
          signal: this.eventAbort.signal
        });
        if (!response.ok || !response.body) throw new Error(`Event stream HTTP ${response.status}`);
        backoff = 1000;
        let buffer = '';
        for await (const chunk of response.body) {
          if (!this.running) break;
          buffer += Buffer.from(chunk).toString('utf8');
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            try {
              const event = JSON.parse(dataLine.slice(5).trim());
              if (event.type === 'call') void this.reconcile();
            } catch { /* malformed advisory doorbell: reconciliation still covers it */ }
          }
        }
      } catch (error) {
        if (!this.running || error?.name === 'AbortError') break;
        this.logger.warn(`Event channel lost; durable queue reconciliation remains active: ${error.message}`);
      }
      if (this.running) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async reconcile() {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.#reconcileImpl().finally(() => { this.reconcilePromise = null; });
    return this.reconcilePromise;
  }

  async #reconcileImpl() {
    const queue = await fetchJson(this.config.serverUrl, '/v1/device/calls', { token: this.credentials.token });
    for (const item of queue?.calls ?? []) {
      if (!this.running) break;
      await this.#execute(item.callId);
    }
  }

  async #execute(callId) {
    if (this.seen.has(callId)) return;
    this.#remember(callId);
    let claim;
    try {
      claim = await fetchJson(this.config.serverUrl, `/v1/device/calls/${encodeURIComponent(callId)}/claim`, {
        method: 'POST', token: this.credentials.token, body: {}
      });
    } catch (error) {
      if (error.status === 409 || error.status === 404) return;
      this.seen.delete(callId); // allow reconciliation retry after transient failure
      throw error;
    }

    try {
      await this.client.ensureReady();
      if (!this.catalog.has(claim.toolName)) await this.#register(true);
      const localTool = this.catalog.get(claim.toolName);
      if (!localTool) throw new Error(`Local tool is unavailable: ${claim.toolName}`);
      if (localTool.schemaHash !== claim.schemaHash) {
        throw new Error(`Tool schema changed before execution: ${claim.toolName}`);
      }
      const result = await this.client.callTool(claim.toolName, claim.args, this.config.callTimeoutMs);
      await fetchJson(this.config.serverUrl, `/v1/device/calls/${encodeURIComponent(callId)}/complete`, {
        method: 'POST', token: this.credentials.token, body: { result }, timeoutMs: this.config.callTimeoutMs
      });
    } catch (error) {
      try {
        await fetchJson(this.config.serverUrl, `/v1/device/calls/${encodeURIComponent(callId)}/fail`, {
          method: 'POST', token: this.credentials.token,
          body: { error: { name: error?.name || 'Error', message: String(error?.message || 'Remote execution failed').slice(0, 2000) } }
        });
      } catch (reportError) {
        this.logger.warn(`Could not report failure for ${callId}: ${reportError.message}`);
      }
    }
  }

  #remember(callId) {
    this.seen.add(callId);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
  }
}
