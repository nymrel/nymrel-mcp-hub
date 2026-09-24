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
  const second = new InstanceLease(file, { ttlMs: 5000, waitMs: 100, logger: { warn() {}, error() {} } });
  await assert.rejects(second.acquire(), /active Nymrel Remote server/);
  await first.release();
  await second.acquire();
  await second.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('production instance lease waits for a fresh orphan marker to expire', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-lease-orphan-'));
  const file = path.join(dir, 'server.lease');
  await fs.writeFile(file, JSON.stringify({ owner: 'terminated-container' }));
  const started = Date.now();
  const lease = await new InstanceLease(file, { ttlMs: 100, waitMs: 1000, logger: { warn() {}, error() {} } }).acquire();
  assert.ok(Date.now() - started >= 90, 'a fresh marker must not be reclaimed immediately');
  await lease.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('production instance lease waiter acquires after graceful release', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-lease-handoff-'));
  const file = path.join(dir, 'server.lease');
  const first = await new InstanceLease(file, { ttlMs: 5000, logger: { warn() {}, error() {} } }).acquire();
  const second = new InstanceLease(file, { ttlMs: 5000, waitMs: 1000, logger: { warn() {}, error() {} } });
  const waiting = second.acquire();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await first.release();
  await waiting;
  assert.equal(second.held, true);
  await second.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('production instance lease does not take over a renewed live owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-lease-active-'));
  const file = path.join(dir, 'server.lease');
  const first = await new InstanceLease(file, { ttlMs: 1200, logger: { warn() {}, error() {} } }).acquire();
  const second = new InstanceLease(file, { ttlMs: 1200, waitMs: 1500, logger: { warn() {}, error() {} } });
  await assert.rejects(second.acquire(), /active Nymrel Remote server/);
  assert.equal(first.held, true);
  await first.release();
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
