import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InstanceLease } from '../src/instance-lease.js';

test('production instance lease rejects a second active server and can be released', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-lease-'));
  const file = path.join(dir, 'server.lease');
  const first = await new InstanceLease(file, { ttlMs: 5000, logger: { warn() {}, error() {} } }).acquire();
  const second = new InstanceLease(file, { ttlMs: 5000, logger: { warn() {}, error() {} } });
  await assert.rejects(second.acquire(), /active Nymrel Remote server/);
  await first.release();
  await second.acquire();
  await second.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('production instance lease can recover a stale crash marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-lease-stale-'));
  const file = path.join(dir, 'server.lease');
  await fs.writeFile(file, JSON.stringify({ owner: 'dead' }));
  const old = new Date(Date.now() - 20_000);
  await fs.utimes(file, old, old);
  const lease = await new InstanceLease(file, { ttlMs: 5000, logger: { warn() {}, error() {} } }).acquire();
  await lease.release();
  await fs.rm(dir, { recursive: true, force: true });
});
