/** Thin MCP adapter over the pinned canonical Protocol v2 implementation. */
import { validateProofInput } from './proofInput.js';
import { createReceipt } from '../vendor/proof-ledger/receipt.js';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const proofLedgerToolDefinition: MCPToolDefinition = {
  name: 'nymrel_proof_ledger',
  description: 'Creates a canonical Protocol v2 receipt signed with caller-supplied HMAC-SHA256 or Ed25519 material. A receipt records a claim; it does not prove the action ran. Never uses a built-in trust key.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', minLength: 1 },
      agentId: { type: 'string', minLength: 1 },
      payload: { type: 'object', description: 'JSON claim stored in signed metadata.' },
      signingKey: { type: 'string', minLength: 1, description: 'Caller-supplied HMAC secret or Ed25519 private key (raw 32-byte hex). MCP requests may be logged by your client.' },
      algorithm: { type: 'string', enum: ['HMAC-SHA256', 'Ed25519'] },
      keyId: { type: 'string', minLength: 1 },
      prevProofHash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: 'Optional reference stored in signed metadata; chain continuity is not checked.' },
    },
    required: ['action', 'agentId', 'payload', 'signingKey', 'algorithm'],
  },
};

export async function executeProofLedger(args: unknown): Promise<ToolExecutionResult> {
  try {
    validateProofInput(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    const a = args as Record<string, unknown>;
    const allowed = new Set(['action', 'agentId', 'payload', 'signingKey', 'algorithm', 'keyId', 'prevProofHash']);
    if (Object.keys(a).some(k => !allowed.has(k))) throw new Error();
    for (const key of ['action', 'agentId', 'signingKey']) {
      if (typeof a[key] !== 'string' || !(a[key] as string).trim()) throw new Error();
    }
    if (!a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)) throw new Error();
    if ('keyId' in a && (typeof a.keyId !== 'string' || !a.keyId.trim())) throw new Error();
    if ('prevProofHash' in a && (typeof a.prevProofHash !== 'string' || a.prevProofHash.length !== 64 || !/^[0-9a-fA-F]+$/.test(a.prevProofHash))) throw new Error();
    if (a.algorithm !== 'HMAC-SHA256' && a.algorithm !== 'Ed25519') throw new Error();
    if (a.algorithm === 'Ed25519' && ((a.signingKey as string).length !== 64 || !/^[0-9a-fA-F]+$/.test(a.signingKey as string))) throw new Error();
    const receipt = await createReceipt({
      task: { name: a.action as string, runner: a.agentId as string, status: 'ATTESTED' },
      signingKey: a.signingKey as string, signerIdentity: a.agentId as string,
      algorithm: a.algorithm,
      includeGitContext: false,
      ...(a.keyId === undefined ? {} : { keyId: a.keyId as string }),
      metadata: { payload: a.payload, ...(a.prevProofHash === undefined ? {} : { prevProofHash: a.prevProofHash }) },
    });
    // Reserve verification-envelope headroom before returning a minted receipt.
    validateProofInput({ receipt, publicKeyOrSecret: a.signingKey, expectedAlgorithm: a.algorithm });
    return { content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'INVALID_PROOF_INPUT: Supply action, agentId, JSON object payload and a valid signingKey; only HMAC-SHA256 and Ed25519 are supported.' }) }], isError: true };
  }
}
