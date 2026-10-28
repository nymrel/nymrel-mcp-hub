import path from 'node:path';
import { deepClone } from './canonical.js';
import { sha256 } from './crypto.js';

const JOB_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLATFORM = new Set(['any', 'linux', 'darwin', 'win32']);
const TOP_LEVEL_KEYS = new Set(['version', 'jobs']);
const JOB_KEYS = new Set(['id', 'command', 'cwd', 'timeoutSeconds', 'platform', 'dependsOn', 'requiresNetwork']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function normalizeCwd(value) {
  const cwd = value ?? '.';
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 512) throw new Error('job.cwd must be a non-empty string');
  if (path.isAbsolute(cwd)) throw new Error('job.cwd must be repository-relative');
  const normalized = path.posix.normalize(cwd.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('job.cwd must remain inside the repository');
  return normalized === '' ? '.' : normalized;
}

export function validateCiManifest(input, { maxJobs = 32 } = {}) {
  assertObject(input, 'manifest');
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, 'manifest');
  if (input.version !== 1) throw new Error('manifest.version must be 1');
  if (!Array.isArray(input.jobs) || input.jobs.length === 0 || input.jobs.length > maxJobs) {
    throw new Error(`manifest.jobs must contain 1 to ${maxJobs} jobs`);
  }

  const ids = new Set();
  const jobs = input.jobs.map((job, index) => {
    assertObject(job, `manifest.jobs[${index}]`);
    rejectUnknownKeys(job, JOB_KEYS, `manifest.jobs[${index}]`);
    if (typeof job.id !== 'string' || !JOB_ID_RE.test(job.id)) throw new Error(`manifest.jobs[${index}].id is invalid`);
    if (ids.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
    ids.add(job.id);
    if (typeof job.command !== 'string' || job.command.trim().length === 0 || job.command.length > 32768) {
      throw new Error(`job ${job.id} command must be a non-empty string`);
    }
    const timeoutSeconds = job.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
      throw new Error(`job ${job.id} timeoutSeconds must be an integer from 1 to 7200`);
    }
    const platform = job.platform ?? 'any';
    if (!PLATFORM.has(platform)) throw new Error(`job ${job.id} platform is invalid`);
    const dependsOn = job.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string' || !JOB_ID_RE.test(id))) {
      throw new Error(`job ${job.id} dependsOn must be an array of job ids`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`job ${job.id} dependsOn contains duplicates`);
    if (job.requiresNetwork !== undefined && typeof job.requiresNetwork !== 'boolean') {
      throw new Error(`job ${job.id} requiresNetwork must be boolean`);
    }
    return {
      id: job.id,
      command: job.command,
      cwd: normalizeCwd(job.cwd),
      timeoutSeconds,
      platform,
      dependsOn: [...dependsOn],
      requiresNetwork: job.requiresNetwork ?? false
    };
  });

  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    for (const dep of job.dependsOn) {
      if (!byId.has(dep)) throw new Error(`job ${job.id} depends on unknown job ${dep}`);
      if (dep === job.id) throw new Error(`job ${job.id} cannot depend on itself`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const job of jobs) visit(job.id);

  const manifest = { version: 1, jobs };
  return { manifest: deepClone(manifest), manifestHash: sha256(manifest) };
}

export function buildCiPlan(input, {
  selectedJobs,
  platform = process.platform,
  allowNetwork = false
} = {}) {
  const { manifest, manifestHash } = validateCiManifest(input);
  const byId = new Map(manifest.jobs.map((job) => [job.id, job]));
  const requested = selectedJobs?.length ? selectedJobs : manifest.jobs.map((job) => job.id);
  const wanted = new Set();
  const include = (id) => {
    const job = byId.get(id);
    if (!job) throw new Error(`unknown selected job: ${id}`);
    for (const dep of job.dependsOn) include(dep);
    wanted.add(id);
  };
  for (const id of requested) include(id);

  const ordered = [];
  const emitted = new Set();
  const emit = (id) => {
    if (emitted.has(id)) return;
    const job = byId.get(id);
    for (const dep of job.dependsOn) if (wanted.has(dep)) emit(dep);
    if (wanted.has(id)) {
      if (job.platform !== 'any' && job.platform !== platform) throw new Error(`job ${id} requires ${job.platform}, runner is ${platform}`);
      if (job.requiresNetwork && !allowNetwork) throw new Error(`job ${id} requires network but runner policy denies it`);
      ordered.push(job);
      emitted.add(id);
    }
  };
  for (const id of manifest.jobs.map((job) => job.id)) if (wanted.has(id)) emit(id);

  const plan = { version: 1, manifestHash, platform, allowNetwork: Boolean(allowNetwork), jobs: ordered };
  return { plan: deepClone(plan), planHash: sha256(plan) };
}
