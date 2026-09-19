/** Versioned proof receipt generation and verification. */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { canonicalHash, type CanonicalizationProfile } from './canonical.js';
import { RECEIPT_PROTOCOL, validateReceiptEnvelope } from './envelope.js';
import { MerkleTree, type MerkleProfile } from './merkle.js';
import { ProofSigner, type SignatureAlgorithm, type SignatureRecord } from './signer.js';

export const RECEIPT_VERSION = '2.0.0' as const;
export const LEGACY_RECEIPT_VERSION = '1.0.0' as const;
export const RFC6962_MERKLE_ALGORITHM = 'RFC6962-SHA256' as const;
export const LEGACY_MERKLE_ALGORITHM = 'SHA-256' as const;

export interface ProofTask {
  name: string;
  description?: string;
  runner: string;
  status: 'SUCCESS' | 'FAILURE' | 'ATTESTED' | 'WARNING';
  exitCode: number;
  durationMs?: number;
  command?: string;
}

export interface ProofGitContext {
  commit: string;
  branch: string;
  dirty: boolean;
  remote?: string;
}

export interface ProofEnvironment {
  platform: string;
  arch: string;
  hostname?: string;
  runtime: string;
  git?: ProofGitContext;
}

export interface ProofArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
}

export interface ProofReceipt {
  version: typeof RECEIPT_VERSION | typeof LEGACY_RECEIPT_VERSION;
  protocol: typeof RECEIPT_PROTOCOL;
  proofId: string;
  timestamp: string;
  parentOrganization: string;
  task: ProofTask;
  environment: ProofEnvironment;
  artifacts: ProofArtifact[];
  merkle: {
    algorithm: typeof RFC6962_MERKLE_ALGORITHM | typeof LEGACY_MERKLE_ALGORITHM;
    leaves: string[];
    root: string;
  };
  signature: SignatureRecord;
  metadata: Record<string, unknown>;
}

export interface CreateReceiptOptions {
  task: Partial<ProofTask> & { name: string };
  artifacts?: Array<{ path: string; data?: Buffer | string; mimeType?: string }>;
  signingKey: string;
  signerIdentity: string;
  keyId?: string;
  algorithm?: SignatureAlgorithm;
  metadata?: Record<string, unknown>;
  cwd?: string;
  includeHostname?: boolean;
  /** Opt in only for a trusted working directory and Git installation. */
  includeGitContext?: boolean;
}

export interface VerificationResult {
  valid: boolean;
  trusted: boolean;
  merkleValid: boolean;
  signatureChecked: boolean;
  signatureValid: boolean | null;
  artifactsValid: boolean;
  errors: string[];
  warnings: string[];
  checkedArtifacts: number;
  receipt: ProofReceipt | null;
}

export type VerifyReceiptOptions = {
  checkFilesOnDisk?: boolean;
  cwd?: string;
} & (
  | { publicKeyOrSecret?: undefined; expectedAlgorithm?: undefined }
  | { publicKeyOrSecret: string; expectedAlgorithm: SignatureAlgorithm }
);

export function sanitizeGitRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (/^git@[A-Za-z0-9.-]+:[^\s?#]+$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Gathers non-secret Git lineage without throwing outside a repository. */
export function getGitContext(cwd: string = process.cwd()): ProofGitContext | undefined {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const dirty = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().length > 0;
    let remote: string | undefined;
    try {
      remote = sanitizeGitRemote(
        execSync('git config --get remote.origin.url', {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString()
      );
    } catch {
      remote = undefined;
    }
    return { commit, branch, dirty, ...(remote === undefined ? {} : { remote }) };
  } catch {
    return undefined;
  }
}

export async function hashArtifact(
  artifactPath: string,
  data?: Buffer | string,
  cwd: string = process.cwd()
): Promise<ProofArtifact> {
  const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(cwd, artifactPath);
  const buffer = data === undefined
    ? await fs.readFile(resolved)
    : typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : data;
  return {
    path: path.relative(cwd, resolved).replace(/\\/g, '/') || artifactPath,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
  };
}

function profilesFor(version: ProofReceipt['version']): {
  canonical: CanonicalizationProfile;
  merkle: MerkleProfile;
} {
  return version === LEGACY_RECEIPT_VERSION
    ? { canonical: 'legacy', merkle: 'legacy-duplicated' }
    : { canonical: 'rfc8785', merkle: 'rfc6962' };
}

function receiptLeaves(
  task: ProofTask,
  environment: ProofEnvironment,
  artifacts: ProofArtifact[],
  version: ProofReceipt['version']
): string[] {
  const { canonical } = profilesFor(version);
  const artifactLeaves = version === LEGACY_RECEIPT_VERSION
    ? artifacts.map((artifact) => artifact.sha256)
    : artifacts.map((artifact) => canonicalHash(artifact, 'sha256', canonical));
  return [
    canonicalHash(task, 'sha256', canonical),
    canonicalHash(environment, 'sha256', canonical),
    ...artifactLeaves,
  ];
}

function signingPayload(receipt: Pick<
  ProofReceipt,
  'protocol' | 'version' | 'proofId' | 'timestamp' | 'parentOrganization' | 'task' | 'merkle' | 'metadata'
>, signature?: Pick<
  SignatureRecord,
  'algorithm' | 'keyId' | 'signerIdentity' | 'timestamp'
>): Record<string, unknown> {
  const legacyPayload = {
    proofId: receipt.proofId,
    timestamp: receipt.timestamp,
    parentOrganization: receipt.parentOrganization,
    taskName: receipt.task.name,
    merkleRoot: receipt.merkle.root,
  };
  if (receipt.version === LEGACY_RECEIPT_VERSION) return legacyPayload;
  if (signature === undefined) {
    throw new TypeError('Protocol v2 signing requires a complete signature header');
  }
  return {
    protocol: receipt.protocol,
    version: receipt.version,
    merkleAlgorithm: receipt.merkle.algorithm,
    metadataHash: canonicalHash(receipt.metadata),
    signatureAlgorithm: signature.algorithm,
    signatureKeyId: signature.keyId,
    signerIdentity: signature.signerIdentity,
    signatureTimestamp: signature.timestamp,
    ...legacyPayload,
  };
}

export async function createReceipt(options: CreateReceiptOptions): Promise<ProofReceipt> {
  const cwd = options.cwd ?? process.cwd();
  const proofId = `prf_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
  const timestamp = new Date().toISOString();
  const artifacts: ProofArtifact[] = [];
  for (const item of options.artifacts ?? []) {
    const artifact = await hashArtifact(item.path, item.data, cwd);
    artifacts.push(item.mimeType === undefined ? artifact : { ...artifact, mimeType: item.mimeType });
  }

  const git = options.includeGitContext === true ? getGitContext(cwd) : undefined;
  const environment: ProofEnvironment = {
    platform: os.platform(),
    arch: os.arch(),
    runtime: `node ${process.version}`,
    ...(options.includeHostname === true ? { hostname: os.hostname() } : {}),
    ...(git === undefined ? {} : { git }),
  };
  const task: ProofTask = {
    name: options.task.name,
    runner: options.task.runner ?? 'nymrel-agent',
    status: options.task.status ?? 'SUCCESS',
    exitCode: options.task.exitCode ?? 0,
    ...(options.task.description === undefined ? {} : { description: options.task.description }),
    ...(options.task.durationMs === undefined ? {} : { durationMs: options.task.durationMs }),
    ...(options.task.command === undefined ? {} : { command: options.task.command }),
  };

  const leaves = receiptLeaves(task, environment, artifacts, RECEIPT_VERSION);
  const merkleTree = new MerkleTree(leaves, { isPreHashed: true, profile: 'rfc6962' });
  const algorithm = options.algorithm ?? 'HMAC-SHA256';
  const keyId = options.keyId ?? (algorithm === 'Ed25519' ? 'ed25519-primary' : 'hmac-default');
  const metadata = options.metadata ?? {};
  const unsigned: Pick<
    ProofReceipt,
    'protocol' | 'version' | 'proofId' | 'timestamp' | 'parentOrganization' | 'task' | 'merkle' | 'metadata'
  > = {
    protocol: RECEIPT_PROTOCOL,
    version: RECEIPT_VERSION,
    proofId,
    timestamp,
    parentOrganization: 'Nymrel',
    task,
    merkle: {
      algorithm: RFC6962_MERKLE_ALGORITHM,
      leaves: merkleTree.getLeaves(),
      root: merkleTree.getRoot(),
    },
    metadata,
  };
  const signatureHeader = {
    algorithm,
    keyId,
    signerIdentity: options.signerIdentity,
    timestamp: new Date().toISOString(),
  };
  const signature: SignatureRecord = {
    ...signatureHeader,
    value: ProofSigner.signPayload(
      signingPayload(unsigned, signatureHeader),
      options.signingKey,
      algorithm,
      'rfc8785'
    ),
  };
  return {
    ...unsigned,
    environment,
    artifacts,
    signature,
    metadata,
  };
}

async function artifactPathWithin(cwd: string, artifactPath: string): Promise<string | undefined> {
  // Reject network/drive paths and lexical escapes before any filesystem lookup.
  if (path.posix.isAbsolute(artifactPath) || path.win32.isAbsolute(artifactPath) || /^[A-Za-z]:/.test(artifactPath)) return undefined;
  const unresolvedRoot = path.resolve(cwd);
  const portablePath = artifactPath.replace(/\\/g, '/');
  const lexicalRelative = path.relative(unresolvedRoot, path.resolve(unresolvedRoot, portablePath));
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return undefined;
  const root = await fs.realpath(unresolvedRoot).catch(() => unresolvedRoot);
  const unresolvedCandidate = path.resolve(root, portablePath);
  const candidate = await fs.realpath(unresolvedCandidate).catch(() => unresolvedCandidate);
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return candidate;
  return undefined;
}

export async function verifyReceipt(
  receiptInput: unknown,
  options: VerifyReceiptOptions = {}
): Promise<VerificationResult> {
  const invalidContext = (message: string): VerificationResult => ({
    valid: false, trusted: false, merkleValid: false, signatureChecked: false,
    signatureValid: null, artifactsValid: false, checkedArtifacts: 0, receipt: null,
    errors: [message], warnings: [],
  });
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return invalidContext('Verification options must be an object');
  }
  const hasKey = options.publicKeyOrSecret != null;
  const hasAlgorithm = options.expectedAlgorithm != null;
  if (hasKey !== hasAlgorithm || (hasKey && (
    typeof options.publicKeyOrSecret !== 'string' || options.publicKeyOrSecret.length === 0 ||
    !['HMAC-SHA256', 'Ed25519'].includes(options.expectedAlgorithm as string)
  ))) {
    return invalidContext('A non-empty verification key and explicit expectedAlgorithm must be supplied together');
  }
  const envelope = validateReceiptEnvelope(receiptInput);
  if (!envelope.valid) {
    return {
      valid: false,
      trusted: false,
      merkleValid: false,
      signatureChecked: false,
      signatureValid: null,
      artifactsValid: false,
      errors: envelope.errors.map((error) =>
        `Envelope ${error.code}${error.path === null ? '' : ` at ${error.path}`}: ${error.message}`
      ),
      warnings: [],
      checkedArtifacts: 0,
      receipt: null,
    };
  }

  const receipt = receiptInput as ProofReceipt;
  if (hasKey && options.expectedAlgorithm !== receipt.signature.algorithm) {
    return invalidContext('Receipt signature algorithm does not match expectedAlgorithm');
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const cwd = options.cwd ?? process.cwd();
  const profiles = profilesFor(receipt.version);
  let expectedLeaves: string[];
  try {
    // Metadata is a signed v2 field even when this caller asks only for integrity.
    canonicalHash(receipt.metadata, 'sha256', profiles.canonical);
    expectedLeaves = receiptLeaves(receipt.task, receipt.environment, receipt.artifacts, receipt.version);
  } catch {
    return invalidContext('Receipt contains values outside its canonical JSON profile');
  }
  const calculatedTree = new MerkleTree(expectedLeaves, {
    isPreHashed: true,
    profile: profiles.merkle,
  });
  const calculatedRoot = calculatedTree.getRoot();
  const calculatedLeaves = calculatedTree.getLeaves();
  const leavesValid =
    calculatedLeaves.length === receipt.merkle.leaves.length &&
    calculatedLeaves.every(
      (leaf, index) => leaf === receipt.merkle.leaves[index].toLowerCase()
    );
  const merkleValid =
    leavesValid && calculatedRoot === receipt.merkle.root.toLowerCase();
  if (!leavesValid) errors.push('Merkle leaf list does not match the receipt payload');
  if (calculatedRoot !== receipt.merkle.root.toLowerCase()) {
    errors.push(
      `Merkle root mismatch: recorded '${receipt.merkle.root}', recalculated '${calculatedRoot}'`
    );
  }

  let artifactsValid = true;
  let checkedArtifacts = 0;
  if (options.checkFilesOnDisk === true) {
    for (const artifact of receipt.artifacts) {
      const fullPath = await artifactPathWithin(cwd, artifact.path);
      if (fullPath === undefined) {
        artifactsValid = false;
        errors.push(`Artifact path escapes verification root: '${artifact.path}'`);
        continue;
      }
      try {
        const fileData = await fs.readFile(fullPath);
        checkedArtifacts++;
        const actualHash = createHash('sha256').update(fileData).digest('hex');
        if (actualHash !== artifact.sha256.toLowerCase()) {
          artifactsValid = false;
          errors.push(`Artifact tampered: '${artifact.path}' (hash mismatch)`);
        }
      } catch (error: unknown) {
        artifactsValid = false;
        errors.push(
          `Artifact missing on disk: '${artifact.path}' (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
  }

  const signatureChecked = hasKey;
  let signatureValid: boolean | null = null;
  if (signatureChecked) {
    signatureValid = ProofSigner.verifySignature(
      signingPayload(receipt, receipt.signature),
      receipt.signature.value,
      options.publicKeyOrSecret as string,
      options.expectedAlgorithm as SignatureAlgorithm,
      profiles.canonical
    );
    if (!signatureValid) errors.push('Cryptographic signature verification failed with provided key');
  } else {
    warnings.push('Signature was not cryptographically verified (no public key or secret provided)');
  }

  if (receipt.version === LEGACY_RECEIPT_VERSION) {
    warnings.push('Legacy v1 authenticates artifact digests only, not artifact path/size/mimeType or artifact count, metadata, or signature identity fields');
  }

  const valid = errors.length === 0;
  return {
    valid,
    trusted: valid && signatureValid === true,
    merkleValid,
    signatureChecked,
    signatureValid,
    artifactsValid,
    errors,
    warnings,
    checkedArtifacts,
    receipt,
  };
}
