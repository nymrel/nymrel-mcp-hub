/**
 * Cross-runtime receipt-envelope interoperability validator.
 *
 * Performs focused, dependency-free structural validation of a Nymrel proof
 * receipt envelope (protocol identifier, version, and core-field shape) so a
 * caller can decide whether an envelope is portable across the TypeScript and
 * Python runtimes BEFORE running cryptographic verification.
 *
 * This module is intentionally self-contained: it imports nothing, performs no
 * hashing, no signature checks, and no Merkle recomputation. Structural shape
 * only. Cryptographic integrity remains the responsibility of
 * `verifyReceipt` / `verify_receipt`.
 *
 * The Python mirror lives at `python/nymrel_proof_ledger/envelope.py` and must
 * produce byte-identical error codes, paths, ordering, and messages for the
 * same input. Any change here must be mirrored there (and vice versa).
 *
 * @module @nymrel/proof-ledger/core/envelope
 */

/** Protocol identifier emitted by every Nymrel proof receipt. */
export const RECEIPT_PROTOCOL = 'nymrel-proof-ledger';

/** Current emission version plus the legacy version accepted for verification. */
export const SUPPORTED_RECEIPT_VERSION = '2.0.0';
export const SUPPORTED_RECEIPT_VERSIONS = ['1.0.0', SUPPORTED_RECEIPT_VERSION] as const;

/** Stable machine-readable error codes reported by envelope validation. */
export const EnvelopeErrorCode = {
  ENVELOPE_NOT_OBJECT: 'ENVELOPE_NOT_OBJECT',
  PROTOCOL_MISSING: 'PROTOCOL_MISSING',
  PROTOCOL_UNSUPPORTED: 'PROTOCOL_UNSUPPORTED',
  VERSION_MISSING: 'VERSION_MISSING',
  VERSION_UNSUPPORTED: 'VERSION_UNSUPPORTED',
  FIELD_MISSING: 'FIELD_MISSING',
  FIELD_TYPE_INVALID: 'FIELD_TYPE_INVALID',
  TIMESTAMP_MALFORMED: 'TIMESTAMP_MALFORMED',
  HASH_MALFORMED: 'HASH_MALFORMED',
} as const;

export type EnvelopeErrorCode =
  (typeof EnvelopeErrorCode)[keyof typeof EnvelopeErrorCode];

/** A single structural validation failure. */
export interface EnvelopeError {
  /** Stable machine-readable code (see {@link EnvelopeErrorCode}). */
  code: EnvelopeErrorCode;
  /** Dotted path to the offending field, or null for top-level failures. */
  path: string | null;
  /** Human-readable detail; phrasing is kept identical across runtimes. */
  message: string;
}

/** Focused result of receipt-envelope validation. */
export interface ReceiptEnvelopeValidationResult {
  valid: boolean;
  errors: EnvelopeError[];
}

const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * RFC 3339 timestamp shape check. Applied identically in both runtimes so the
 * accept/reject set is deterministic cross-runtime (unlocale-dependent date
 * parsers are deliberately avoided).
 */
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Validates the structural envelope of a Nymrel proof receipt.
 *
 * Unknown extra fields are allowed (forward compatibility); unsupported
 * protocol or version values are rejected with dedicated codes. Errors are
 * reported in a fixed field order so both runtimes emit identical sequences.
 */
export function validateReceiptEnvelope(input: unknown): ReceiptEnvelopeValidationResult {
  if (!isPlainObject(input)) {
    return {
      valid: false,
      errors: [
        {
          code: EnvelopeErrorCode.ENVELOPE_NOT_OBJECT,
          path: null,
          message: 'Receipt envelope must be a JSON object.',
        },
      ],
    };
  }

  const errors: EnvelopeError[] = [];
  const push = (code: EnvelopeErrorCode, path: string | null, message: string): void => {
    errors.push({ code, path, message });
  };
  const requireNonEmptyString = (
    container: Record<string, unknown>,
    key: string,
    path: string = key
  ): boolean => {
    if (!(key in container)) {
      push(EnvelopeErrorCode.FIELD_MISSING, path, `Required field '${path}' is missing.`);
      return false;
    }
    if (!isNonEmptyString(container[key])) {
      push(
        EnvelopeErrorCode.FIELD_TYPE_INVALID,
        path,
        `Field '${path}' must be a non-empty string.`
      );
      return false;
    }
    return true;
  };

  // 1. Protocol identifier
  if (!('protocol' in input)) {
    push(EnvelopeErrorCode.PROTOCOL_MISSING, 'protocol', "Required field 'protocol' is missing.");
  } else if (input['protocol'] !== RECEIPT_PROTOCOL) {
    push(
      EnvelopeErrorCode.PROTOCOL_UNSUPPORTED,
      'protocol',
      `Unsupported protocol identifier: expected '${RECEIPT_PROTOCOL}', got ${renderValue(input['protocol'])}.`
    );
  }

  // 2. Version gate
  if (!('version' in input)) {
    push(EnvelopeErrorCode.VERSION_MISSING, 'version', "Required field 'version' is missing.");
  } else if (
    typeof input['version'] !== 'string' ||
    !SUPPORTED_RECEIPT_VERSIONS.includes(
      input['version'] as (typeof SUPPORTED_RECEIPT_VERSIONS)[number]
    )
  ) {
    push(
      EnvelopeErrorCode.VERSION_UNSUPPORTED,
      'version',
      `Unsupported receipt version: expected one of '1.0.0', '${SUPPORTED_RECEIPT_VERSION}', got ${renderValue(input['version'])}.`
    );
  }

  // 3. Core scalar fields
  requireNonEmptyString(input, 'proofId');

  if (!('timestamp' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'timestamp', "Required field 'timestamp' is missing.");
  } else if (typeof input['timestamp'] !== 'string') {
    push(
      EnvelopeErrorCode.FIELD_TYPE_INVALID,
      'timestamp',
      "Field 'timestamp' must be a non-empty string."
    );
  } else if (!RFC3339_PATTERN.test(input['timestamp'])) {
    push(
      EnvelopeErrorCode.TIMESTAMP_MALFORMED,
      'timestamp',
      "Field 'timestamp' must be an RFC 3339 timestamp string."
    );
  }

  requireNonEmptyString(input, 'parentOrganization');

  // 4. Task record
  const task = input['task'];
  if (!('task' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'task', "Required field 'task' is missing.");
  } else if (!isPlainObject(task)) {
    push(EnvelopeErrorCode.FIELD_TYPE_INVALID, 'task', "Field 'task' must be a JSON object.");
  } else {
    requireNonEmptyString(task, 'name', 'task.name');
  }

  // 5. Environment record
  const environment = input['environment'];
  if (!('environment' in input)) {
    push(
      EnvelopeErrorCode.FIELD_MISSING,
      'environment',
      "Required field 'environment' is missing."
    );
  } else if (!isPlainObject(environment)) {
    push(
      EnvelopeErrorCode.FIELD_TYPE_INVALID,
      'environment',
      "Field 'environment' must be a JSON object."
    );
  } else {
    requireNonEmptyString(environment, 'platform', 'environment.platform');
    requireNonEmptyString(environment, 'arch', 'environment.arch');
    requireNonEmptyString(environment, 'runtime', 'environment.runtime');
  }

  // 6. Artifacts array
  const artifacts = input['artifacts'];
  if (!('artifacts' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'artifacts', "Required field 'artifacts' is missing.");
  } else if (!Array.isArray(artifacts)) {
    push(EnvelopeErrorCode.FIELD_TYPE_INVALID, 'artifacts', "Field 'artifacts' must be an array.");
  } else {
    artifacts.forEach((item, index) => {
      const itemPath = `artifacts[${index}]`;
      if (!isPlainObject(item)) {
        push(
          EnvelopeErrorCode.FIELD_TYPE_INVALID,
          itemPath,
          `Field '${itemPath}' must be a JSON object.`
        );
        return;
      }
      requireNonEmptyString(item, 'path', `${itemPath}.path`);
      if (!('sha256' in item)) {
        push(
          EnvelopeErrorCode.FIELD_MISSING,
          `${itemPath}.sha256`,
          `Required field '${itemPath}.sha256' is missing.`
        );
      } else if (typeof item['sha256'] !== 'string' || !HEX_64_PATTERN.test(item['sha256'])) {
        push(
          EnvelopeErrorCode.HASH_MALFORMED,
          `${itemPath}.sha256`,
          `Field '${itemPath}.sha256' must be a 64-character hexadecimal SHA-256 digest.`
        );
      }
      if (!('sizeBytes' in item)) {
        push(
          EnvelopeErrorCode.FIELD_MISSING,
          `${itemPath}.sizeBytes`,
          `Required field '${itemPath}.sizeBytes' is missing.`
        );
      } else if (!isNonNegativeInteger(item['sizeBytes'])) {
        push(
          EnvelopeErrorCode.FIELD_TYPE_INVALID,
          `${itemPath}.sizeBytes`,
          `Field '${itemPath}.sizeBytes' must be an integer greater than or equal to 0.`
        );
      }
    });
  }

  // 7. Merkle block
  const merkle = input['merkle'];
  if (!('merkle' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'merkle', "Required field 'merkle' is missing.");
  } else if (!isPlainObject(merkle)) {
    push(EnvelopeErrorCode.FIELD_TYPE_INVALID, 'merkle', "Field 'merkle' must be a JSON object.");
  } else {
    if (!('algorithm' in merkle)) {
      push(
        EnvelopeErrorCode.FIELD_MISSING,
        'merkle.algorithm',
        "Required field 'merkle.algorithm' is missing."
      );
    } else if (
      typeof input['version'] === 'string' &&
      SUPPORTED_RECEIPT_VERSIONS.includes(
        input['version'] as (typeof SUPPORTED_RECEIPT_VERSIONS)[number]
      )
    ) {
      const expectedAlgorithm =
        input['version'] === SUPPORTED_RECEIPT_VERSION ? 'RFC6962-SHA256' : 'SHA-256';
      if (merkle['algorithm'] !== expectedAlgorithm) {
        push(
          EnvelopeErrorCode.FIELD_TYPE_INVALID,
          'merkle.algorithm',
          `Field 'merkle.algorithm' must be '${expectedAlgorithm}' for receipt version '${String(input['version'])}'.`
        );
      }
    }

    const leaves = merkle['leaves'];
    if (!('leaves' in merkle)) {
      push(
        EnvelopeErrorCode.FIELD_MISSING,
        'merkle.leaves',
        "Required field 'merkle.leaves' is missing."
      );
    } else if (!Array.isArray(leaves)) {
      push(
        EnvelopeErrorCode.FIELD_TYPE_INVALID,
        'merkle.leaves',
        "Field 'merkle.leaves' must be an array."
      );
    } else {
      leaves.forEach((leaf, index) => {
        if (typeof leaf !== 'string' || !HEX_64_PATTERN.test(leaf)) {
          push(
            EnvelopeErrorCode.HASH_MALFORMED,
            `merkle.leaves[${index}]`,
            `Field 'merkle.leaves[${index}]' must be a 64-character hexadecimal SHA-256 digest.`
          );
        }
      });
    }

    if (!('root' in merkle)) {
      push(
        EnvelopeErrorCode.FIELD_MISSING,
        'merkle.root',
        "Required field 'merkle.root' is missing."
      );
    } else if (typeof merkle['root'] !== 'string' || !HEX_64_PATTERN.test(merkle['root'])) {
      push(
        EnvelopeErrorCode.HASH_MALFORMED,
        'merkle.root',
        "Field 'merkle.root' must be a 64-character hexadecimal SHA-256 digest."
      );
    }
  }

  // 8. Signature record
  const signature = input['signature'];
  if (!('signature' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'signature', "Required field 'signature' is missing.");
  } else if (!isPlainObject(signature)) {
    push(
      EnvelopeErrorCode.FIELD_TYPE_INVALID,
      'signature',
      "Field 'signature' must be a JSON object."
    );
  } else {
    const signatureAlgorithmValid = requireNonEmptyString(
      signature,
      'algorithm',
      'signature.algorithm'
    );
    if (
      signatureAlgorithmValid &&
      signature['algorithm'] !== 'HMAC-SHA256' &&
      signature['algorithm'] !== 'Ed25519'
    ) {
      push(
        EnvelopeErrorCode.FIELD_TYPE_INVALID,
        'signature.algorithm',
        "Field 'signature.algorithm' must be 'HMAC-SHA256' or 'Ed25519'."
      );
    }
    requireNonEmptyString(signature, 'keyId', 'signature.keyId');
    requireNonEmptyString(signature, 'signerIdentity', 'signature.signerIdentity');
    const signatureValueValid = requireNonEmptyString(signature, 'value', 'signature.value');
    if (signatureValueValid && ['HMAC-SHA256', 'Ed25519'].includes(signature['algorithm'] as string)) {
      const length = signature['algorithm'] === 'HMAC-SHA256' ? 64 : 128;
      const value = signature['value'] as string;
      if (value.length !== length || !/^[0-9a-fA-F]+$/.test(value)) {
        push(EnvelopeErrorCode.FIELD_TYPE_INVALID, 'signature.value',
          "Field 'signature.value' encoding must match the declared algorithm.");
      }
    }

    if (!('timestamp' in signature)) {
      push(
        EnvelopeErrorCode.FIELD_MISSING,
        'signature.timestamp',
        "Required field 'signature.timestamp' is missing."
      );
    } else if (
      typeof signature['timestamp'] !== 'string' ||
      !RFC3339_PATTERN.test(signature['timestamp'])
    ) {
      push(
        EnvelopeErrorCode.TIMESTAMP_MALFORMED,
        'signature.timestamp',
        "Field 'signature.timestamp' must be an RFC 3339 timestamp string."
      );
    }
  }

  // 9. Metadata object
  if (!('metadata' in input)) {
    push(EnvelopeErrorCode.FIELD_MISSING, 'metadata', "Required field 'metadata' is missing.");
  } else if (!isPlainObject(input['metadata'])) {
    push(
      EnvelopeErrorCode.FIELD_TYPE_INVALID,
      'metadata',
      "Field 'metadata' must be a JSON object."
    );
  }

  return { valid: errors.length === 0, errors };
}
