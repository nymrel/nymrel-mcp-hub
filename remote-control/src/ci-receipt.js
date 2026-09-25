import { sha256 } from './crypto.js';

const HASH_RE = /^[0-9a-f]{64}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const JOB_STATUS = new Set([
  'success',
  'failed',
  'timed_out',
  'output_limit',
  'infrastructure_error',
  'skipped_dependency'
]);

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
}

function assertIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

export function verifyTrustedCiReceipt(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CI receipt must be an object');
  if (value.schema !== 'nymrel.ci.trusted/v1') throw new Error('Unsupported CI receipt schema');
  if (value.sourceTrust !== 'trusted_studio') throw new Error('CI receipt trust lane is not trusted_studio');
  if (typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) {
    throw new Error('CI receipt repository is invalid');
  }
  if (typeof value.commitSha !== 'string' || !SHA_RE.test(value.commitSha)) throw new Error('CI receipt commitSha is invalid');
  assertHash(value.manifestHash, 'CI receipt manifestHash');
  assertHash(value.planHash, 'CI receipt planHash');
  assertHash(value.receiptHash, 'CI receipt receiptHash');
  assertIso(value.startedAt, 'CI receipt startedAt');
  assertIso(value.completedAt, 'CI receipt completedAt');
  if (!['success', 'failure'].includes(value.conclusion)) throw new Error('CI receipt conclusion is invalid');
  if (!value.runner || typeof value.runner !== 'object' || Array.isArray(value.runner)) throw new Error('CI receipt runner is invalid');
  for (const field of ['hostname', 'platform', 'arch']) {
    if (typeof value.runner[field] !== 'string' || !value.runner[field]) throw new Error(`CI receipt runner.${field} is invalid`);
  }
  if (!Array.isArray(value.jobs) || value.jobs.length === 0 || value.jobs.length > 32) throw new Error('CI receipt jobs are invalid');
  for (const job of value.jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.id !== 'string' || !job.id) {
      throw new Error('CI receipt job is invalid');
    }
    if (!JOB_STATUS.has(job.status)) throw new Error(`CI receipt job ${job.id} status is invalid`);
    if (job.stdoutHash !== undefined) assertHash(job.stdoutHash, `CI receipt job ${job.id} stdoutHash`);
    if (job.stderrHash !== undefined) assertHash(job.stderrHash, `CI receipt job ${job.id} stderrHash`);
  }

  const { receiptHash, ...body } = value;
  const calculated = sha256(body);
  if (calculated !== receiptHash.toLowerCase()) throw new Error('CI receipt hash mismatch');

  const expectations = {
    repository: expected.repository,
    commitSha: expected.commitSha?.toLowerCase(),
    manifestHash: expected.manifestHash?.toLowerCase(),
    planHash: expected.planHash?.toLowerCase()
  };
  for (const [field, expectedValue] of Object.entries(expectations)) {
    if (expectedValue === undefined) continue;
    const actual = typeof value[field] === 'string' ? value[field].toLowerCase() : value[field];
    if (actual !== expectedValue) throw new Error(`CI receipt ${field} does not match expected value`);
  }
  return value;
}

export function extractTrustedCiReceipt(output, expected = {}) {
  if (typeof output !== 'string') throw new Error('CI process output must be a string');
  const marker = 'NYMREL_CI_RECEIPT ';
  const index = output.lastIndexOf(marker);
  if (index < 0) throw new Error('CI receipt marker not found');
  const line = output.slice(index + marker.length).split(/\r?\n/, 1)[0].trim();
  if (!line) throw new Error('CI receipt payload is empty');
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('CI receipt payload is not valid JSON');
  }
  return verifyTrustedCiReceipt(parsed, expected);
}
