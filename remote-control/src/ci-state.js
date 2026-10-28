import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './crypto.js';
import { verifyTrustedCiReceipt } from './ci-receipt.js';

const RUN_ID_RE = /^[0-9a-f]{64}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const STATE_SCHEMA = 'nymrel.ci.state/v1';

function validateRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value)) throw new Error('CI runId must be a SHA-256 hex digest');
  return value.toLowerCase();
}

function normalizeIdentity(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CI state identity must be an object');
  const out = {};
  if (value.repository !== undefined) {
    if (typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) {
      throw new Error('CI state repository is invalid');
    }
    out.repository = value.repository;
  }
  if (value.commitSha !== undefined) {
    if (typeof value.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.commitSha)) throw new Error('CI state commitSha is invalid');
    out.commitSha = value.commitSha.toLowerCase();
  }
  for (const field of ['manifestHash', 'planHash']) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || !HASH_RE.test(value[field])) throw new Error(`CI state ${field} is invalid`);
    out[field] = value[field].toLowerCase();
  }
  return out;
}

function statePath(directory, runId, suffix) {
  return path.join(directory, `${validateRunId(runId)}.${suffix}.json`);
}

async function writeImmutableJson(file, value) {
  const payload = `${JSON.stringify(value)}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function finalizeRecord(body) {
  return { ...body, recordHash: sha256(body) };
}

function verifyRecord(record, expectedRunId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('CI state record is invalid');
  if (record.schema !== STATE_SCHEMA) throw new Error('Unsupported CI state schema');
  const runId = validateRunId(record.runId);
  if (runId !== validateRunId(expectedRunId)) throw new Error('CI state runId mismatch');
  if (!['running', 'verified', 'invalid'].includes(record.status)) throw new Error('CI state status is invalid');
  if (typeof record.storedAt !== 'string' || !Number.isFinite(Date.parse(record.storedAt))) throw new Error('CI state storedAt is invalid');
  if (typeof record.recordHash !== 'string' || !HASH_RE.test(record.recordHash)) throw new Error('CI state recordHash is invalid');
  const { recordHash, ...body } = record;
  if (sha256(body) !== recordHash.toLowerCase()) throw new Error('CI state record hash mismatch');
  const identity = normalizeIdentity(record.identity ?? {});
  if (record.exitCode !== undefined && record.exitCode !== null && !Number.isInteger(record.exitCode)) {
    throw new Error('CI state exitCode is invalid');
  }
  if (record.status === 'verified') {
    if (!record.receipt) throw new Error('Verified CI state is missing receipt');
    verifyTrustedCiReceipt(record.receipt, identity);
  } else if (record.receipt !== undefined) {
    throw new Error('Non-verified CI state cannot contain a receipt');
  }
  if (record.status === 'invalid' && (typeof record.error !== 'string' || !record.error || record.error.length > 1000)) {
    throw new Error('Invalid CI state must contain a bounded error');
  }
  return { ...record, runId, identity };
}

export async function writeTrustedCiRunning(directory, { runId, identity }) {
  const normalizedRunId = validateRunId(runId);
  const body = {
    schema: STATE_SCHEMA,
    runId: normalizedRunId,
    status: 'running',
    storedAt: new Date().toISOString(),
    identity: normalizeIdentity(identity)
  };
  const record = finalizeRecord(body);
  const file = statePath(directory, normalizedRunId, 'running');
  await writeImmutableJson(file, record);
  return record;
}

export async function writeTrustedCiFinal(directory, { runId, identity, receipt, exitCode = null, error }) {
  const normalizedRunId = validateRunId(runId);
  const normalizedIdentity = normalizeIdentity(identity);
  const verified = receipt !== undefined;
  if (verified) verifyTrustedCiReceipt(receipt, normalizedIdentity);
  const body = {
    schema: STATE_SCHEMA,
    runId: normalizedRunId,
    status: verified ? 'verified' : 'invalid',
    storedAt: new Date().toISOString(),
    identity: normalizedIdentity,
    exitCode,
    ...(verified ? { receipt } : { error: String(error || 'Trusted CI ended without a verifiable receipt').slice(0, 1000) })
  };
  const record = finalizeRecord(body);
  const file = statePath(directory, normalizedRunId, 'final');
  await writeImmutableJson(file, record);
  return record;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('CI state file is not valid JSON');
    throw error;
  }
}

export async function readTrustedCiState(directory, runId) {
  const normalizedRunId = validateRunId(runId);
  const finalRecord = await readJson(statePath(directory, normalizedRunId, 'final'));
  if (finalRecord) return verifyRecord(finalRecord, normalizedRunId);
  const runningRecord = await readJson(statePath(directory, normalizedRunId, 'running'));
  if (runningRecord) return verifyRecord(runningRecord, normalizedRunId);
  return null;
}
