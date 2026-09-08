import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomId } from './crypto.js';

const EMPTY_STATE = Object.freeze({
  version: 1,
  revision: 0,
  devices: {},
  calls: {},
  pairings: {},
  receipts: []
});

function cloneEmpty() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonFileStore {
  constructor(filePath, { lockTimeoutMs = 5000, staleLockMs = 30000 } = {}) {
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.#writeAtomic(cloneEmpty());
    }
    if (os.platform() !== 'win32') {
      await fs.chmod(this.filePath, 0o600).catch(() => {});
    }
    const state = await this.read();
    this.#validate(state);
    return this;
  }

  async read() {
    const raw = await fs.readFile(this.filePath, 'utf8');
    const state = JSON.parse(raw);
    this.#validate(state);
    return state;
  }

  async transaction(mutator) {
    const run = async () => {
      const release = await this.#acquireLock();
      try {
        const state = await this.read();
        const result = await mutator(state);
        state.revision = Number(state.revision || 0) + 1;
        await this.#writeAtomic(state);
        return result;
      } finally {
        await release();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async #writeAtomic(state) {
    const temp = `${this.filePath}.${process.pid}.${randomId('tmp_')}`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.filePath);
  }

  async #acquireLock() {
    const started = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        return async () => {
          await handle.close().catch(() => {});
          await fs.unlink(this.lockPath).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) {
            await fs.unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {}
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('Store lock timeout');
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  #validate(state) {
    if (!state || state.version !== 1 || typeof state !== 'object') throw new Error('Unsupported store format');
    for (const key of ['devices', 'calls', 'pairings']) {
      if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Corrupt store: ${key}`);
    }
    if (!Array.isArray(state.receipts)) throw new Error('Corrupt store: receipts');
  }
}

export function defaultStorePath() {
  return path.join(os.homedir(), '.nymrel-remote', 'server-state.json');
}
