import fs from 'node:fs/promises';
import os from 'node:os';
import { randomId } from './crypto.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class InstanceLease {
  constructor(filePath, { ttlMs = 30_000, waitMs = Math.min(240_000, ttlMs * 2 + 5_000), logger = console } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.waitMs = waitMs;
    this.logger = logger;
    this.owner = randomId('instance_');
    this.timer = null;
    this.held = false;
    this.onLost = null;
  }

  async acquire() {
    const deadline = Date.now() + this.waitMs;
    let staleAttempts = 0;
    while (true) {
      try {
        const handle = await fs.open(this.filePath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(this.#record())); }
        finally { await handle.close(); }
        this.held = true;
        this.#schedule();
        return this;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let stat;
        try {
          stat = await fs.stat(this.filePath);
        } catch (statError) {
          if (statError?.code === 'ENOENT') { await sleep(10); continue; }
          throw statError;
        }
        if (Date.now() - stat.mtimeMs <= this.ttlMs) {
          if (Date.now() >= deadline) {
            throw new Error('Another active Nymrel Remote server holds the production instance lease');
          }
          await sleep(Math.min(250, Math.max(10, deadline - Date.now())));
          continue;
        }
        // A terminated container can leave a fresh marker. Recheck before reclaiming it,
        // since a live owner may have renewed between the first stat and this point.
        try {
          const latest = await fs.stat(this.filePath);
          if (latest.mtimeMs !== stat.mtimeMs) continue;
          await fs.unlink(this.filePath);
        } catch (reclaimError) {
          if (reclaimError?.code !== 'ENOENT') throw reclaimError;
        }
        if (++staleAttempts > 8 && Date.now() >= deadline) {
          throw new Error('Could not acquire production instance lease');
        }
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
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
