import path from 'node:path';
import { buildCiPlan, validateCiManifest } from './ci-contract.js';
import { sha256 } from './crypto.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeRepoRelative(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${label} must be repository-relative`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must remain inside the repository`);
  }
  return normalized;
}

function validateRepoRoot(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw new Error('repoRoot must be an absolute path on the target device');
  }
  if (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)) {
    throw new Error('repoRoot must be an absolute path on the target device');
  }
  return value;
}

export async function dispatchTrustedCi({
  broker,
  principal,
  deviceId,
  repoRoot,
  repository,
  commitSha,
  manifest,
  manifestPath = '.nymrel/ci.json',
  selectedJobs,
  allowNetwork = false,
  attempt = 1
}) {
  if (!broker || typeof broker.listDevices !== 'function' || typeof broker.createCall !== 'function') {
    throw new Error('broker is required');
  }
  if (!principal || principal.typ !== 'user') throw new Error('user principal is required');
  if (typeof deviceId !== 'string' || !deviceId) throw new Error('deviceId is required');
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) throw new Error('repository must be owner/name');
  if (typeof commitSha !== 'string' || !SHA_RE.test(commitSha)) throw new Error('commitSha must be a full 40-character SHA');
  if (typeof allowNetwork !== 'boolean') throw new Error('allowNetwork must be boolean');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000) throw new Error('attempt must be an integer from 1 to 1000');

  const targetRoot = validateRepoRoot(repoRoot);
  const targetManifest = normalizeRepoRelative(manifestPath, 'manifestPath');
  const { manifestHash } = validateCiManifest(manifest);
  const devices = await broker.listDevices(principal);
  const device = devices.find((item) => item.id === deviceId);
  if (!device) throw new Error('CI target device not found');
  if (device.status !== 'online' || !device.mcpReady) throw new Error('CI target device must be online and MCP-ready');

  const { plan, planHash } = buildCiPlan(manifest, {
    selectedJobs,
    platform: device.platform,
    allowNetwork
  });

  const projected = await broker.projectedTools(principal);
  const ciTool = projected.find((tool) =>
    tool?._meta?.['nymrel/deviceId'] === deviceId &&
    tool?._meta?.['nymrel/originalToolName'] === 'start_trusted_ci'
  );
  if (!ciTool) throw new Error('CI target device does not expose start_trusted_ci');

  const args = {
    repoRoot: targetRoot,
    repository,
    commitSha: commitSha.toLowerCase(),
    manifestPath: targetManifest,
    selectedJobs: plan.jobs.map((job) => job.id),
    allowNetwork,
    expectedManifestHash: manifestHash,
    expectedPlanHash: planHash
  };
  const dispatchIdentity = {
    schema: 'nymrel.ci.remote-dispatch/v1',
    tenantId: principal.tenant,
    deviceId,
    repository,
    commitSha: commitSha.toLowerCase(),
    repoRoot: targetRoot,
    manifestPath: targetManifest,
    manifestHash,
    planHash,
    attempt
  };
  const dispatchKey = sha256(dispatchIdentity);
  const call = await broker.createCall(principal, ciTool.name, args, {
    sourceProfile: 'nymrel-ci-trusted',
    idempotencyKey: dispatchKey
  });

  return {
    schema: 'nymrel.ci.remote-dispatch/v1',
    sourceTrust: 'trusted_studio',
    deviceId,
    repository,
    commitSha: commitSha.toLowerCase(),
    manifestHash,
    planHash,
    dispatchKey,
    attempt,
    call
  };
}
