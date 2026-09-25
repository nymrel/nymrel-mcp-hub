import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { buildCiPlan } from './ci-contract.js';
import { sha256 } from './crypto.js';

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'PROGRAMDATA', 'ProgramData', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)',
  'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'CI'
]);

function nowIso() { return new Date().toISOString(); }

export function buildSafeCiEnvironment(source = process.env) {
  const out = { CI: 'true', NYMREL_CI: '1' };
  for (const [key, value] of Object.entries(source || {})) {
    if (!SAFE_ENV_KEYS.has(key) || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function execFileText(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function assertTrustedCheckout(repoRoot, commitSha, git = execFileText) {
  if (typeof commitSha !== 'string' || !SHA_RE.test(commitSha)) throw new Error('commitSha must be a full 40-character SHA');
  const root = await fs.realpath(path.resolve(repoRoot));
  const top = await git('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  const canonicalTop = await fs.realpath(path.resolve(top));
  if (canonicalTop !== root) throw new Error('repoRoot must be the Git worktree root');
  const head = await git('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (head.toLowerCase() !== commitSha.toLowerCase()) throw new Error(`checkout HEAD ${head} does not match expected ${commitSha}`);
  const status = await git('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root });
  if (status.trim()) throw new Error('trusted CI checkout must be clean before execution');
  return root;
}

function defaultExecuteJob(job, { repoRoot, environment, maxOutputBytes = 2 * 1024 * 1024, onOutput = () => {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdoutHash = crypto.createHash('sha256');
    const stderrHash = crypto.createHash('sha256');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let limitExceeded = false;
    let timedOut = false;
    let settled = false;
    const cwd = path.resolve(repoRoot, job.cwd);
    const child = spawn(job.command, {
      cwd,
      env: environment,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const absorb = (stream, chunk) => {
      const buffer = Buffer.from(chunk);
      if (stream === 'stdout') {
        stdoutBytes += buffer.length;
        stdoutHash.update(buffer);
      } else {
        stderrBytes += buffer.length;
        stderrHash.update(buffer);
      }
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        limitExceeded = true;
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        return;
      }
      onOutput(stream, buffer);
    };
    child.stdout.on('data', (chunk) => absorb('stdout', chunk));
    child.stderr.on('data', (chunk) => absorb('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, job.timeoutSeconds * 1000);
    timer.unref?.();

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        durationMs: Date.now() - started,
        stdoutBytes,
        stderrBytes,
        stdoutHash: stdoutHash.digest('hex'),
        stderrHash: stderrHash.digest('hex'),
        timedOut,
        outputLimitExceeded: limitExceeded,
        ...payload
      });
    };

    child.once('error', (error) => finish({ status: 'infrastructure_error', exitCode: null, error: String(error?.message || error).slice(0, 1000) }));
    child.once('close', (code, signal) => {
      if (timedOut) return finish({ status: 'timed_out', exitCode: code, signal });
      if (limitExceeded) return finish({ status: 'output_limit', exitCode: code, signal });
      finish({ status: code === 0 ? 'success' : 'failed', exitCode: code, signal: signal || null });
    });
  });
}

export async function runTrustedCiCheckout({
  repoRoot,
  repository,
  commitSha,
  manifest,
  selectedJobs,
  allowNetwork = false,
  environment = process.env,
  executeJob = defaultExecuteJob,
  git = execFileText,
  onOutput
}) {
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) throw new Error('repository must be owner/name');
  const root = await assertTrustedCheckout(repoRoot, commitSha, git);
  const { plan, planHash } = buildCiPlan(manifest, { selectedJobs, platform: process.platform, allowNetwork });
  const safeEnvironment = buildSafeCiEnvironment(environment);
  const startedAt = nowIso();
  const results = [];
  const statusById = new Map();

  for (const job of plan.jobs) {
    const blockedBy = job.dependsOn.find((id) => statusById.get(id) !== 'success');
    if (blockedBy) {
      const skipped = { id: job.id, status: 'skipped_dependency', blockedBy };
      results.push(skipped);
      statusById.set(job.id, skipped.status);
      continue;
    }
    const result = await executeJob(job, { repoRoot: root, environment: safeEnvironment, onOutput });
    const normalized = {
      id: job.id,
      status: result.status,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      durationMs: Number(result.durationMs || 0),
      stdoutBytes: Number(result.stdoutBytes || 0),
      stderrBytes: Number(result.stderrBytes || 0),
      stdoutHash: result.stdoutHash || sha256(''),
      stderrHash: result.stderrHash || sha256(''),
      ...(result.error ? { error: String(result.error).slice(0, 1000) } : {})
    };
    results.push(normalized);
    statusById.set(job.id, normalized.status);
  }

  const conclusion = results.every((job) => job.status === 'success') ? 'success' : 'failure';
  const receipt = {
    schema: 'nymrel.ci.trusted/v1',
    repository,
    commitSha: commitSha.toLowerCase(),
    sourceTrust: 'trusted_studio',
    runner: { hostname: os.hostname(), platform: process.platform, arch: process.arch },
    manifestHash: plan.manifestHash,
    planHash,
    startedAt,
    completedAt: nowIso(),
    conclusion,
    jobs: results
  };
  return { ...receipt, receiptHash: sha256(receipt) };
}
