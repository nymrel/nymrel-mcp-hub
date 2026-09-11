import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSupervisorLog } from '../src/supervisor-log.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nymrel-supervisor-log-'));
}

test('supervisor log is disabled when no path is configured', () => {
  assert.equal(createSupervisorLog({ filePath: undefined }), null);
  assert.equal(createSupervisorLog({ filePath: '' }), null);
});

test('supervisor log writes UTF-8 lines with an ISO timestamp and stream tag', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'nested', 'supervisor.log');
    const fixed = new Date('2026-09-11T17:00:00.000Z');
    const log = createSupervisorLog({ filePath: file, now: () => fixed });
    log.supervisor('Starting Nymrel Remote device agent (backoff=1000ms)');
    log.agentOut('Nymrel Remote agent online for JalenPC (native backend)');
    log.agentErr('Event channel lost; durable queue reconciliation remains active: terminated\n');
    log.agentOut('');

    const raw = await fs.readFile(file);
    assert.equal(raw[0] !== 0xff && raw[1] !== 0xfe, true, 'must not be UTF-16LE');
    assert.equal(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, 'must not carry a BOM');
    const text = raw.toString('utf8');
    assert.equal(text, [
      '2026-09-11T17:00:00.000Z [supervisor] Starting Nymrel Remote device agent (backoff=1000ms)',
      '2026-09-11T17:00:00.000Z [agent] Nymrel Remote agent online for JalenPC (native backend)',
      '2026-09-11T17:00:00.000Z [agent:err] Event channel lost; durable queue reconciliation remains active: terminated',
      ''
    ].join('\n'));
    assert.doesNotMatch(text, /NativeCommandError|CategoryInfo/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('supervisor log keeps the bootstrap pairing and online markers greppable', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'supervisor.log');
    const log = createSupervisorLog({ filePath: file });
    log.agentOut('Pair this device with code: ABCD-EFGH');
    log.agentOut('Nymrel Remote agent online for JalenPC (native backend)');
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /Pair this device with code:\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{4})/);
    assert.match(text, /Nymrel Remote agent online for/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('supervisor log splits multi-line messages so every line carries a timestamp', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'supervisor.log');
    const log = createSupervisorLog({ filePath: file, now: () => new Date(0) });
    log.agentErr('line one\r\nline two');
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    assert.deepEqual(lines, [
      '1970-01-01T00:00:00.000Z [agent:err] line one',
      '1970-01-01T00:00:00.000Z [agent:err] line two'
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('supervisor log rotates once to .1 when it would exceed the size bound', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'supervisor.log');
    const log = createSupervisorLog({ filePath: file, maxBytes: 64 * 1024, now: () => new Date(0) });
    const filler = 'x'.repeat(1024);
    for (let i = 0; i < 80; i += 1) log.supervisor(`${i} ${filler}`);

    // Read each file exactly once; sizes come from the bytes read, not a separate stat.
    const current = await fs.readFile(file);
    const previous = await fs.readFile(`${file}.1`);
    assert.ok(current.length <= 64 * 1024, 'current file stays within the bound');
    assert.ok(previous.length > 0, 'rotated file preserves earlier history');
    assert.match(current.toString('utf8'), /\[supervisor\] 79 x/);
    assert.match(previous.toString('utf8'), /\[supervisor\] 0 x/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
