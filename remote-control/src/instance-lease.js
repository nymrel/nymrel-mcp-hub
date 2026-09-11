import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomId } from './crypto.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

export class InstanceLease {
  constructor(filePath, { ttlMs = 30_000, logger = console } = {}) {
    this.filePath = filePath;
    this.recoveryPath = `${filePath}.recovery`;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.owner = randomId('instance_');
    this.timer = null;
    this.held = false;
    this.onLost = null;
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await exists(this.recoveryPath)) {
        await sleep(25);
        continue;
      }
      try {
        const handle = await fs.open(this.filePath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(this.#record()));
          await handle.sync();
        } finally { await handle.close(); }
        if (await exists(this.recoveryPath)) {
          await this.#unlinkIfOwned();
          await sleep(25);
          continue;
        }
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
        await this.#recoverStale();
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
    if (await exists(this.recoveryPath)) throw new Error('Production instance lease recovery marker present; manual recovery is required');
    throw new Error('Could not acquire production instance lease');
  }

  async release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    try { await this.#unlinkIfOwned(); }
    catch (error) { this.logger.warn?.(`Could not release instance lease: ${error.name}`); }
  }

  #record() {
    return { owner: this.owner, pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() };
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
      const now = new Date();
      await fs.utimes(this.filePath, now, now);
      this.#schedule();
    } catch (error) {
      this.held = false;
      this.logger.error?.(`Production instance lease lost: ${error.message}`);
      try { this.onLost?.(error); } catch { /* shutdown callback must not crash lease code */ }
    }
  }

  async #recoverStale() {
    let recovery;
    try {
      recovery = await fs.open(this.recoveryPath, 'wx', 0o600);
      await recovery.writeFile(JSON.stringify({ owner: randomId('recover_'), pid: process.pid, at: Date.now() }));
      await recovery.sync();
    } catch (error) {
      if (error?.code === 'EEXIST') return;
      throw error;
    }
    try {
      let stat;
      try { stat = await fs.stat(this.filePath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      if (Date.now() - stat.mtimeMs <= this.ttlMs) return;
      const quarantine = `${this.filePath}.stale.${randomId('q_')}`;
      try {
        await fs.rename(this.filePath, quarantine);
        await fs.rm(quarantine, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } finally {
      await recovery.close().catch(() => {});
      await fs.rm(this.recoveryPath, { force: true }).catch(() => {});
    }
  }

  async #unlinkIfOwned() {
    try {
      const current = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (current?.owner === this.owner) await fs.unlink(this.filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}