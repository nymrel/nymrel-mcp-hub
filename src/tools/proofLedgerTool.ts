/**
 * Legacy compatibility integrity receipt tool.
 *
 * This tool deliberately does NOT authenticate a signer. Authenticated/trusted
 * receipts belong to the canonical nymrel-proof-ledger Protocol v2 implementation.
 */

import * as crypto from 'node:crypto';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

const INTEGRITY_PROTOCOL = 'nymrel-mcp-integrity-receipt';
const INTEGRITY_VERSION = '0.1.0';
const HASH_RE = /^[a-f0-9]{64}$/i;

export const proofLedgerToolDefinition: MCPToolDefinition = {
  name: 'nymrel_proof_ledger',
  description: 'Creates an unsigned compatibility integrity receipt. It can detect receipt tampering but does not authenticate a signer or establish trust. Use canonical Nymrel Proof Ledger Protocol v2 for authenticated receipts.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Semantic action name (e.g. "git_commit", "file_mutation", "api_call")'
      },
      agentId: {
        type: 'string',
        description: 'Identifier claimed by the caller; this compatibility receipt does not authenticate it'
      },
      payload: {
        type: 'object',
        description: 'JSON metadata or diff payload to integrity-seal'
      },
      prevProofHash: {
        type: 'string',
        description: 'Optional 64-hex previous root used only for integrity chaining'
      }
    },
    required: ['action', 'agentId', 'payload']
  }
};

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export async function executeProofLedger(args: {
  action: string;
  agentId: string;
  payload: any;
  prevProofHash?: string;
}): Promise<ToolExecutionResult> {
  const timestamp = new Date().toISOString();
  const canonicalData = canonicalJson({
    action: args.action,
    agentId: args.agentId,
    payload: args.payload,
    timestamp
  });

  const leafHash = sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonicalData, 'utf8')]));
  const prevHash = args.prevProofHash || sha256('genesis-block-nymrel');
  if (!HASH_RE.test(prevHash)) {
    throw new Error('prevProofHash must be exactly 64 hexadecimal characters.');
  }

  const rootHash = sha256(Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(prevHash, 'hex'),
    Buffer.from(leafHash, 'hex')
  ]));
  const receiptId = `rcpt-${leafHash.slice(0, 12)}`;

  const receipt = {
    receiptId,
    protocol: INTEGRITY_PROTOCOL,
    version: INTEGRITY_VERSION,
    action: args.action,
    agentId: args.agentId,
    leafHash,
    prevProofHash: prevHash,
    merkleRoot: rootHash,
    proofPath: [prevHash, leafHash],
    authentication: {
      scheme: 'none',
      trusted: false
    },
    trusted: false,
    timestamp,
    warning: 'Integrity-only compatibility receipt. No signer authentication was performed.',
    attestationBadge: `<svg width="220" height="28" xmlns="http://www.w3.org/2000/svg"><rect width="220" height="28" rx="4" fill="#FAF8F2" stroke="#2A332E"/><text x="10" y="18" font-family="monospace" font-size="11" fill="#2A332E">INTEGRITY ONLY: ${receiptId}</text></svg>`
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(receipt, null, 2)
      }
    ]
  };
}
