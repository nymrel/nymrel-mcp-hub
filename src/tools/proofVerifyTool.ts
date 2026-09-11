/**
 * Legacy compatibility integrity receipt verifier.
 *
 * This verifier checks only the local receipt's hash-chain integrity. It never
 * upgrades an unsigned compatibility receipt into authenticated/trusted proof.
 */

import * as crypto from 'node:crypto';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

const INTEGRITY_PROTOCOL = 'nymrel-mcp-integrity-receipt';
const INTEGRITY_VERSION = '0.1.0';
const HASH_RE = /^[a-f0-9]{64}$/i;

export const proofVerifyToolDefinition: MCPToolDefinition = {
  name: 'nymrel_proof_verify',
  description: 'Checks hash integrity for an unsigned Nymrel MCP compatibility receipt. Successful integrity does not authenticate the signer and always returns trusted=false.',
  inputSchema: {
    type: 'object',
    properties: {
      receipt: {
        type: 'object',
        description: 'An unsigned compatibility receipt returned from nymrel_proof_ledger'
      }
    },
    required: ['receipt']
  }
};

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function malformed(error: string): ToolExecutionResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          valid: false,
          verified: false,
          trusted: false,
          integrityValid: false,
          error
        }, null, 2)
      }
    ],
    isError: true
  };
}

export async function executeProofVerify(args: {
  receipt: any;
}): Promise<ToolExecutionResult> {
  const receipt = args.receipt;

  if (!receipt || typeof receipt !== 'object') {
    return malformed('MALFORMED_RECEIPT: receipt must be an object.');
  }
  if (receipt.protocol !== INTEGRITY_PROTOCOL || receipt.version !== INTEGRITY_VERSION) {
    return malformed('UNSUPPORTED_RECEIPT: legacy simulated attestation receipts are not trusted or accepted by this compatibility verifier.');
  }
  if (!HASH_RE.test(receipt.leafHash || '') || !HASH_RE.test(receipt.merkleRoot || '')) {
    return malformed('MALFORMED_RECEIPT: leafHash and merkleRoot must be 64 hexadecimal characters.');
  }

  const prevHash = receipt.prevProofHash || sha256('genesis-block-nymrel');
  if (!HASH_RE.test(prevHash)) {
    return malformed('MALFORMED_RECEIPT: prevProofHash must be 64 hexadecimal characters.');
  }

  const computedRoot = sha256(Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(prevHash, 'hex'),
    Buffer.from(receipt.leafHash, 'hex')
  ]));
  const integrityValid = computedRoot.toLowerCase() === receipt.merkleRoot.toLowerCase();

  const result = {
    valid: integrityValid,
    verified: false,
    trusted: false,
    integrityValid,
    receiptId: receipt.receiptId || 'unknown',
    protocol: receipt.protocol,
    version: receipt.version,
    authentication: {
      scheme: 'none',
      checked: false,
      trusted: false
    },
    checks: {
      merkleRootCalculated: computedRoot,
      merkleRootProvided: receipt.merkleRoot,
      merkleIntegrityValid: integrityValid,
      signerAuthenticationValid: false
    },
    verificationVerdict: integrityValid
      ? 'INTEGRITY_ONLY_NOT_AUTHENTICATED'
      : 'PROOF_INVALID_OR_CORRUPTED',
    warning: 'Integrity-only result. Use canonical Nymrel Proof Ledger Protocol v2 with authenticated key material for trusted=true.',
    verifiedAt: new Date().toISOString()
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: !integrityValid
  };
}
