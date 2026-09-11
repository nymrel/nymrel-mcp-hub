import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalize } from './canonical.js';
import { constantTimeEqual, hmacSha256, randomId } from './crypto.js';

const EMPTY_STATE = Object.freeze({
  version: 2,
  revision: 0,
  devices: {},
  calls: {},
  pairings: {},
  receipts: [],
  integrity: null
});

function cloneEmpty() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export class JsonFileStore {
  constructor(filePath, { integrityKey, lockTimeoutMs = 5000, staleLockMs = 30000 } = {}) {
    if (!Buffer.isBuffer(integrityKey) || integrityKey.length !== 32) throw new Error('JsonFileStore requires a 32-byte integrityKey');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.recoveryPath = `${this.lockPath}.recovery`;
    this.integrityKey = integrityKey;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const release = await this.#acquireLock();
    try {
      try {
        const state = await this.read();
        this.#validate(state);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await this.#writeAtomic(cloneEmpty());
      }
      if (os.platform() !== 'win32') await fs.chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await release();
    }
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

  #stateMac(state) {
    const { integrity: _integrity, ...payload } = state;
    return hmacSha256(this.integrityKey, canonicalize(payload));
  }

  #seal(state) {
    state.integrity = this.#stateMac(state);
    return state;
  }

  async #writeAtomic(state) {
    this.#seal(state);
    const dir = path.dirname(this.filePath);
    const temp = `${this.filePath}.${process.pid}.${randomId('tmp_')}`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.filePath);
    // POSIX durability requires syncing the containing directory after rename.
    // Windows does not expose a portable directory fsync through Node; the atomic
    // replace remains safe against torn JSON but power-loss durability is an
    // environment/storage guarantee there.
    if (os.platform() !== 'win32') {
      try {
        const dirHandle = await fs.open(dir, 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
      }
    }
  }

  async #acquireLock() {
    const started = Date.now();
    const owner = randomId('lock_');
    while (true) {
      if (await exists(this.recoveryPath)) {
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('Store recovery lock present; manual recovery required');
        await sleep(25 + Math.floor(Math.random() * 25));
        continue;
      }
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ owner, pid: process.pid, at: Date.now() }));
        await handle.sync();
        // A stale-lock recovery may have started between our first recovery check
        // and successful creation. Never race that recovery process.
        if (await exists(this.recoveryPath)) {
          await handle.close();
          await this.#unlinkIfOwned(this.lockPath, owner);
          await sleep(25);
          continue;
        }
        const renewEvery = Math.max(1000, Math.floor(this.staleLockMs / 3));
        const renew = setInterval(() => { void this.#renewLock(owner); }, renewEvery);
        renew.unref?.();
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          clearInterval(renew);
          await handle.close().catch(() => {});
          await this.#unlinkIfOwned(this.lockPath, owner);
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const stat = await fs.stat(this.lockPath);
          stale = Date.now() - stat.mtimeMs > this.staleLockMs;
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        if (stale) await this.#recoverStaleLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error('Store lock timeout');
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  async #recoverStaleLock() {
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
      try { stat = await fs.stat(this.lockPath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      if (Date.now() - stat.mtimeMs <= this.staleLockMs) return;
      const quarantine = `${this.lockPath}.stale.${randomId('q_')}`;
      try {
        await fs.rename(this.lockPath, quarantine);
        await fs.rm(quarantine, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } finally {
      await recovery.close().catch(() => {});
      await fs.rm(this.recoveryPath, { force: true }).catch(() => {});
    }
  }

  async #renewLock(owner) {
    try {
      const current = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      if (current.owner !== owner) return;
      const now = new Date();
      await fs.utimes(this.lockPath, now, now);
    } catch { /* losing the lock is detected by the next protected operation */ }
  }

  async #unlinkIfOwned(file, owner) {
    try {
      const current = JSON.parse(await fs.readFile(file, 'utf8'));
      if (current.owner === owner) await fs.unlink(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  #validate(state) {
    if (!state || state.version !== 2 || typeof state !== 'object') throw new Error('Unsupported store format');
    for (const key of ['devices', 'calls', 'pairings']) {
      if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Corrupt store: ${key}`);
    }
    if (!Array.isArray(state.receipts)) throw new Error('Corrupt store: receipts');
    if (typeof state.integrity !== 'string' || !constantTimeEqual(state.integrity, this.#stateMac(state))) {
      throw new Error('State integrity verification failed');
    }
  }
}

export function defaultStorePath() {
  return path.join(os.homedir(), '.nymrel-remote', 'server-state.json');
}