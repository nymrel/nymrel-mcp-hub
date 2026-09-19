/** Authentication is conditional on caller-supplied, independently trusted key material. */
import { verifyReceipt, type VerificationResult } from '../vendor/proof-ledger/receipt.js';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';
import { validateProofInput, validateReceiptTextFields, hasUnsignedExtensions, UNSIGNED_EXTENSION_WARNING } from './proofInput.js';

export const proofVerifyToolDefinition: MCPToolDefinition = {
  name: 'nymrel_proof_verify',
  description: 'Checks canonical Protocol v2 receipt structure and Merkle integrity. Without publicKeyOrSecret, valid receipts remain trusted:false. Authentication requires a matching independently trusted key and expectedAlgorithm. Unknown envelope extension fields may be unsigned. Does not verify execution or files on disk.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    dependentRequired: { publicKeyOrSecret: ['expectedAlgorithm'], expectedAlgorithm: ['publicKeyOrSecret'] },
    properties: {
      receipt: { type: 'object' },
      publicKeyOrSecret: { type: 'string', minLength: 1, description: 'Independently trusted HMAC secret or Ed25519 public key (raw 32-byte hex); never inferred from receipt identity labels.' },
      expectedAlgorithm: { type: 'string', enum: ['HMAC-SHA256', 'Ed25519'], description: 'Required with a key. Choose from trusted key configuration, never from the receipt.' },
    },
    required: ['receipt'],
  },
};

export async function executeProofVerify(args: unknown): Promise<ToolExecutionResult> {
  let result: VerificationResult;
  try {
    validateProofInput(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    const a = args as Record<string, unknown>;
    if (Object.keys(a).some(k => !['receipt', 'publicKeyOrSecret', 'expectedAlgorithm'].includes(k))) throw new Error();
    if (('publicKeyOrSecret' in a) !== ('expectedAlgorithm' in a)) throw new Error();
    if ('publicKeyOrSecret' in a && (typeof a.publicKeyOrSecret !== 'string' || !a.publicKeyOrSecret.trim())) throw new Error();
    const r = a.receipt as Record<string, unknown> | undefined;
    // v1 does not authenticate all identity/metadata fields. Do not promote it to v2 trust.
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.version !== '2.0.0') throw new Error();
    validateReceiptTextFields(r);
    const s = r.signature as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error();
    if ('expectedAlgorithm' in a && (a.expectedAlgorithm !== s.algorithm || !['HMAC-SHA256', 'Ed25519'].includes(a.expectedAlgorithm as string))) throw new Error();
    if (a.expectedAlgorithm === 'Ed25519' && (typeof a.publicKeyOrSecret !== 'string' || a.publicKeyOrSecret.length !== 64 || !/^[0-9a-fA-F]+$/.test(a.publicKeyOrSecret))) throw new Error();
    const length = s.algorithm === 'HMAC-SHA256' ? 64 : s.algorithm === 'Ed25519' ? 128 : 0;
    if (!length || typeof s.value !== 'string' || s.value.length !== length || !/^[0-9a-fA-F]+$/.test(s.value)) throw new Error();
    result = await verifyReceipt(r, { publicKeyOrSecret: a.publicKeyOrSecret as string | undefined });
    if (result.valid && hasUnsignedExtensions(r)) result.warnings.push(UNSIGNED_EXTENSION_WARNING);
  } catch {
    result = { valid: false, trusted: false, merkleValid: false, signatureChecked: false,
      signatureValid: null, artifactsValid: false, checkedArtifacts: 0, receipt: null,
      errors: ['INVALID_PROOF_INPUT: A complete Protocol v2 receipt with a correctly encoded signature and optional non-empty publicKeyOrSecret is required.'], warnings: [] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ...result,
    verified: result.trusted,
    verificationVerdict: !result.valid ? 'INVALID' : result.trusted ? 'SIGNATURE_AUTHENTICATED' : 'INTEGRITY_ONLY',
  }, null, 2) }], isError: !result.valid };
}
