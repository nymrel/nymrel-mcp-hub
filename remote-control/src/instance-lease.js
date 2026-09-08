import fs from 'node:fs/promises';
import os from 'node:os';
import { randomId } from './crypto.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class InstanceLease {
  constructor(filePath, { ttlMs = 30_000, logger = console } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.owner = randomId('instance_');
    this.timer = null;
    this.held = false;
    this.onLost = null;
  }

  async acquire() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await fs.open(this.filePath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(this.#record())); }
        finally { await handle.close(); }
        this.held = true;
        this.#schedule();
        return this;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const stat = await fs.stat(this.filePath);
          stale = Date.now() - stat.mtimeMs > this.ttlMs;
        } catch (statError) {
          if (statError?.code === 'ENOENT') { await sleep(10); continue; }
          throw statError;
        }
        if (!stale) throw new Error('Another active Nymrel Remote server holds the production instance lease');
        await fs.unlink(this.filePath).catch(() => {});
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
    throw new Error('Could not acquire production instance lease');
  }

  async release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    try {
      const current = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (current?.owner === this.owner) await fs.unlink(this.filePath).catch(() => {});
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn?.(`Could not release instance lease: ${error.name}`);
    }
  }

  #record() {
    return { owner: this.owner, pid: process.pid, hostname: os.hostname(), heartbeatAt: new Date().toISOString() };
  }

  #schedule() {
    if (!this.held) return;
    this.timer = setTimeout(() => void this.#renew(), Math.max(1000, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.();
  }

  async #renew() {
    if (!this.held) return;
    try {
      const current = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (current?.owner !== this.owner) throw new Error('instance lease ownership changed');
      await fs.writeFile(this.filePath, JSON.stringify(this.#record()), { mode: 0o600 });
      this.#schedule();
    } catch (error) {
      this.held = false;
      this.logger.error?.(`Production instance lease lost: ${error.message}`);
      try { this.onLost?.(error); } catch { /* shutdown callback must not crash lease code */ }
    }
  }
}
