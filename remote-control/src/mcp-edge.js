import { NymrelRemoteError } from './errors.js';
import { sha256 } from './crypto.js';
import {
  classifyProtocolRequest,
  CLIENT_CAPABILITIES_META_KEY,
  isRecord,
  MODERN_PROTOCOL_VERSION,
  negotiateLegacyProtocolVersion,
  REMOTE_SERVER_INFO,
  stampModernSuccess
} from './mcp-protocol.js';

// Keep meta-tool schemas deliberately simple and stable. Projected device tools preserve
// their original inputSchema byte-for-byte (after JSON canonical parse/clone) in schema.js.
const META_TOOLS = Object.freeze([
  {
    name: 'nymrel_remote_approve_pairing',
    description: 'Approve a pairing code shown by a Nymrel Remote device agent.',
    inputSchema: {
      type: 'object', required: ['userCode'],
      properties: { userCode: { type: 'string', minLength: 3, maxLength: 32 } }, additionalProperties: false
    },
    annotations: { title: 'Approve device pairing', readOnlyHint: false, destructiveHint: false }
  },
  {
    name: 'nymrel_remote_list_devices',
    description: 'List paired remote devices and current reachability.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List remote devices', readOnlyHint: true }
  },
  {
    name: 'nymrel_remote_list_calls',
    description: 'List recent remote calls without task arguments or result bodies.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      additionalProperties: false
    },
    annotations: { title: 'List remote calls', readOnlyHint: true }
  },
  {
    name: 'nymrel_remote_get_call',
    description: 'Get remote call state and, when completed, the tool result.',
    inputSchema: {
      type: 'object', required: ['callId'],
      properties: { callId: { type: 'string', minLength: 1 } }, additionalProperties: false
    },
    annotations: { title: 'Get remote call', readOnlyHint: true }
  },
  {
    name: 'nymrel_remote_wait_call',
    description: 'Wait briefly for a queued/executing remote call to reach a terminal state.',
    inputSchema: {
      type: 'object', required: ['callId'],
      properties: {
        callId: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 120000 }
      }, additionalProperties: false
    },
    annotations: { title: 'Wait for remote call', readOnlyHint: true }
  },
  {
    name: 'nymrel_remote_approve_call',
    description: 'Approve one remote call that the policy engine placed behind an operator gate.',
    inputSchema: {
      type: 'object', required: ['callId'],
      properties: { callId: { type: 'string', minLength: 1 } }, additionalProperties: false
    },
    annotations: { title: 'Approve remote call', readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'nymrel_remote_revoke_device',
    description: 'Revoke a paired device and invalidate its current device token.',
    inputSchema: {
      type: 'object', required: ['deviceId'],
      properties: { deviceId: { type: 'string', minLength: 1 } }, additionalProperties: false
    },
    annotations: { title: 'Revoke remote device', readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'nymrel_remote_verify_audit',
    description: 'Verify the complete tamper-evident remote-control audit chain.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Verify remote audit chain', readOnlyHint: true }
  }
]);

function legacyCapabilities() {
  return { tools: { listChanged: false }, resources: {}, prompts: {} };
}

function modernCapabilities() {
  return { tools: {}, resources: {}, prompts: {} };
}

function textResult(text, structuredContent = undefined, isError = false) {
  const result = { content: [{ type: 'text', text }], isError };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeToolResult(result) {
  if (isRecord(result) && Array.isArray(result.content)) return result;
  return textResult(jsonText(result ?? null), isRecord(result) ? result : { value: result ?? null });
}

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} is required`);
  return value;
}

export class RemoteMcpEdge {
  constructor({ broker, syncWaitMs = 25000 }) {
    this.broker = broker;
    this.syncWaitMs = syncWaitMs;
  }

  async listTools(principal) {
    const projected = await this.broker.projectedTools(principal);
    return [...META_TOOLS, ...projected];
  }

  async handle(req, principal) {
    const id = req?.id ?? null;
    if (!isRecord(req) || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }

    // MCP notifications have no response body.
    const notification = req.id === undefined;
    if (notification) {
      if (req.method === 'notifications/initialized' || req.method.startsWith('notifications/')) return null;
      return null;
    }

    const classification = classifyProtocolRequest(req, id);
    if (classification.error) return classification.error;
    const era = classification.era;

    try {
      let response;
      switch (req.method) {
        case 'initialize': {
          const version = negotiateLegacyProtocolVersion(req.params);
          response = {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: version,
              capabilities: legacyCapabilities(),
              serverInfo: REMOTE_SERVER_INFO,
              instructions: 'Nymrel Remote exposes scoped tools from paired computers. Writes and command execution may require explicit operator approval.'
            }
          };
          break;
        }
        case 'server/discover': {
          response = {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: MODERN_PROTOCOL_VERSION,
              capabilities: modernCapabilities(),
              instructions: 'Remote computer tools are dynamically projected from paired devices with exact input schemas and policy gates.'
            }
          };
          break;
        }
        case 'tools/list': {
          response = { jsonrpc: '2.0', id, result: { tools: await this.listTools(principal) } };
          break;
        }
        case 'tools/call': {
          const params = isRecord(req.params) ? req.params : {};
          const name = params.name;
          const args = isRecord(params.arguments) ? params.arguments : {};
          if (typeof name !== 'string' || !name) {
            response = { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires params.name' } };
            break;
          }
          const result = await this.callTool(principal, name, args, { era, params });
          response = { jsonrpc: '2.0', id, result };
          break;
        }
        default:
          response = { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
      return era === 'modern' && response?.result ? stampModernSuccess(response, req.method) : response;
    } catch (error) {
      const remote = error instanceof NymrelRemoteError;
      return {
        jsonrpc: '2.0', id,
        error: {
          code: remote ? -32000 : -32603,
          message: remote ? error.message : 'Internal error',
          data: remote ? { code: error.code, ...(error.data ? { details: error.data } : {}) } : undefined
        }
      };
    }
  }

  async callTool(principal, name, args, context = {}) {
    if (name === 'nymrel_remote_approve_pairing') {
      const pairing = await this.broker.approvePairing(principal, requireString(args, 'userCode'));
      return textResult(`Approved pairing for ${pairing.deviceName}.`, { pairing });
    }
    if (name === 'nymrel_remote_list_devices') {
      const devices = await this.broker.listDevices(principal);
      return textResult(jsonText(devices), { devices });
    }
    if (name === 'nymrel_remote_list_calls') {
      const calls = await this.broker.listCalls(principal, { limit: Number(args.limit ?? 50) });
      return textResult(jsonText(calls), { calls });
    }
    if (name === 'nymrel_remote_get_call') {
      const call = await this.broker.getCall(principal, requireString(args, 'callId'), { includeResult: true });
      return this.#callStateResult(call);
    }
    if (name === 'nymrel_remote_wait_call') {
      const timeout = Number.isInteger(args.timeoutMs) ? args.timeoutMs : this.syncWaitMs;
      const call = await this.broker.waitForCall(principal, requireString(args, 'callId'), Math.max(0, Math.min(120000, timeout)));
      return this.#callStateResult(call);
    }
    if (name === 'nymrel_remote_approve_call') {
      const call = await this.broker.approveCall(principal, requireString(args, 'callId'));
      const waited = await this.broker.waitForCall(principal, call.id, this.syncWaitMs);
      return this.#callStateResult(waited);
    }
    if (name === 'nymrel_remote_revoke_device') {
      const device = await this.broker.revokeDevice(principal, requireString(args, 'deviceId'));
      return textResult(`Revoked ${device.name} (${device.id}).`, { device });
    }
    if (name === 'nymrel_remote_verify_audit') {
      const audit = await this.broker.verifyAudit(principal);
      return textResult(jsonText(audit), { audit });
    }

    if (context.era === 'modern' && typeof context.params?.requestState === 'string') {
      return this.#resumeMrtrCall(principal, name, args, context.params);
    }

    const call = await this.broker.createCall(principal, name, args);
    if (call.status === 'awaiting_approval') {
      if (context.era === 'modern' && this.#supportsFormElicitation(context.params)) {
        return this.#inputRequiredForCall(principal, name, args, call);
      }
      return this.#callStateResult(call);
    }
    const waited = await this.broker.waitForOwnCall(principal, call.id, this.syncWaitMs);
    return this.#callStateResult(waited);
  }

  #supportsFormElicitation(params) {
    const caps = params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
    const elicitation = caps?.elicitation;
    if (!isRecord(elicitation)) return false;
    return Object.keys(elicitation).length === 0 || isRecord(elicitation.form);
  }

  #encodeRequestState(payload) {
    const envelope = this.broker.cipher.seal(payload, 'mcp-mrtr-approval');
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  }

  #decodeRequestState(value) {
    try {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value) throw new Error('non-canonical encoding');
      const envelope = JSON.parse(bytes.toString('utf8'));
      return this.broker.cipher.open(envelope, 'mcp-mrtr-approval');
    } catch {
      throw new NymrelRemoteError('Invalid MCP requestState', { code: 'INVALID_REQUEST_STATE', status: 400 });
    }
  }

  #inputRequiredForCall(principal, name, args, call) {
    const requestState = this.#encodeRequestState({
      v: 1,
      callId: call.id,
      principal: principal.sub,
      tenant: principal.tenant,
      projectedName: name,
      argsHash: sha256(args ?? {}),
      schemaHash: call.schemaHash,
      exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.ceil(this.broker.config.callTtlMs / 1000))
    });
    return {
      resultType: 'input_required',
      inputRequests: {
        remote_approval: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: `Allow ${call.toolName} on the paired remote device? Nymrel classified this operation as ${call.policy?.capability || 'privileged'} and will execute it only after your confirmation.`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  title: 'Approve remote execution',
                  description: 'Confirm only if you want this remote operation to run now.',
                  default: false
                }
              },
              required: ['confirm']
            }
          }
        }
      },
      requestState
    };
  }

  async #resumeMrtrCall(principal, name, args, params) {
    const state = this.#decodeRequestState(params.requestState);
    const nowSec = Math.floor(Date.now() / 1000);
    if (state?.v !== 1 || state.principal !== principal.sub || state.tenant !== principal.tenant ||
        state.projectedName !== name || state.argsHash !== sha256(args ?? {}) ||
        typeof state.exp !== 'number' || state.exp < nowSec) {
      throw new NymrelRemoteError('MCP requestState does not match this request', { code: 'INVALID_REQUEST_STATE', status: 400 });
    }

    const current = await this.broker.getOwnCall(principal, state.callId, { includeResult: true });
    if (current.schemaHash !== state.schemaHash) {
      throw new NymrelRemoteError('Remote tool schema changed while approval was pending', { code: 'SCHEMA_CHANGED', status: 409 });
    }
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'expired' || current.status === 'cancelled') {
      return this.#callStateResult(current);
    }
    if (current.status === 'queued' || current.status === 'executing') {
      const waited = await this.broker.waitForOwnCall(principal, current.id, this.syncWaitMs);
      return this.#callStateResult(waited);
    }

    const response = params.inputResponses?.remote_approval;
    if (!isRecord(response)) return this.#inputRequiredForCall(principal, name, args, current);
    const action = response.action;
    const confirmed = action === 'accept' && response?.content?.confirm === true;
    if (!confirmed) {
      if (action === 'decline' || action === 'cancel' || (action === 'accept' && response?.content?.confirm === false)) {
        const cancelled = await this.broker.cancelOwnCall(principal, current.id, action === 'accept' ? 'not confirmed' : action);
        return this.#callStateResult(cancelled);
      }
      return this.#inputRequiredForCall(principal, name, args, current);
    }

    // Re-evaluate the current tool policy on the retry so a changed/reduced token cannot
    // use an old confirmation state to bypass scope checks.
    const resolved = await this.broker.resolveProjectedTool(principal, name);
    if (resolved.tool.schemaHash !== current.schemaHash) {
      throw new NymrelRemoteError('Remote tool schema changed while approval was pending', { code: 'SCHEMA_CHANGED', status: 409 });
    }
    const policy = this.broker.policy.evaluate(principal, resolved.tool, args);
    if (policy.decision === 'deny') {
      throw new NymrelRemoteError(policy.reason, { code: 'POLICY_DENIED', status: 403, data: { capability: policy.capability } });
    }
    const approved = await this.broker.approveOwnCall(principal, current.id);
    const waited = await this.broker.waitForOwnCall(principal, approved.id, this.syncWaitMs);
    return this.#callStateResult(waited);
  }

  #callStateResult(call) {
    if (call.status === 'completed') return normalizeToolResult(call.result);
    if (call.status === 'failed') {
      return textResult(`Remote call ${call.id} failed: ${call.error || 'unknown error'}`, { call }, true);
    }
    if (call.status === 'awaiting_approval') {
      return textResult(
        `Remote call ${call.id} requires operator approval before ${call.toolName} can run.`,
        { call, approvalRequired: true }
      );
    }
    if (call.status === 'expired' || call.status === 'cancelled') {
      return textResult(`Remote call ${call.id} is ${call.status}.`, { call }, true);
    }
    return textResult(`Remote call ${call.id} is ${call.status}.`, { call, pending: true });
  }
}
