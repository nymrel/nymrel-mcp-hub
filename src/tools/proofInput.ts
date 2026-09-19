/** Bound work and accept the JSON numeric/string domain shared by both runtimes. */
import { canonicalize } from '../vendor/proof-ledger/canonical.js';

export function isNonBlankProofText(value: unknown): value is string {
  return typeof value === 'string' && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(value);
}

export function validateProofInput(value: unknown): void {
  const pending: Array<[unknown, number]> = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++count > 10000 || depth > 64) throw new Error('Input limit');
    if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER)) throw new Error('Nonportable number');
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
  }
  if (Buffer.byteLength(canonicalize(value), 'utf8') > 1048576) throw new Error('Input size limit');
}

export function validateReceiptTextFields(receipt: Record<string, unknown>): void {
  const signature = receipt.signature as Record<string, unknown> | undefined;
  const merkle = receipt.merkle as Record<string, unknown> | undefined;
  const fields: unknown[] = [receipt.timestamp, signature?.timestamp, merkle?.root];
  if (Array.isArray(merkle?.leaves)) fields.push(...merkle.leaves);
  if (Array.isArray(receipt.artifacts)) {
    for (const artifact of receipt.artifacts) fields.push(artifact?.sha256);
  }
  if (fields.some(value => typeof value === 'string' && /[\r\n]/.test(value))) throw new Error('Malformed receipt field');
}

export const UNSIGNED_EXTENSION_WARNING = 'Unknown top-level, signature, or Merkle extension fields are not authenticated; do not use them as trusted claims.';

export function hasUnsignedExtensions(receipt: Record<string, any>): boolean {
  const shapes: Array<[Record<string, unknown>, string[]]> = [
    [receipt, ['protocol', 'version', 'proofId', 'timestamp', 'parentOrganization', 'task', 'environment', 'artifacts', 'merkle', 'signature', 'metadata']],
    [receipt.signature, ['algorithm', 'keyId', 'signerIdentity', 'value', 'timestamp']],
    [receipt.merkle, ['algorithm', 'leaves', 'root']],
  ];
  return shapes.some(([record, allowed]) => Object.keys(record).some(key => !allowed.includes(key)));
}
