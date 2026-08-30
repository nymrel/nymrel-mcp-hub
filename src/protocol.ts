import { JSONRPCRequest, JSONRPCResponse } from './types/index.js';

export type MCPProtocolEra = 'legacy' | 'modern';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07'
] as const;
export const PREFERRED_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

export const SERVER_INFO = Object.freeze({
  name: '@nymrel/mcp-hub',
  version: '1.0.0'
});

export const SERVER_INSTRUCTIONS =
  'Unified Nymrel MCP Hub providing 14 zero-dependency agent tools, resources, and prompt templates.';

export interface ProtocolClassification {
  era: MCPProtocolEra;
  error?: JSONRPCResponse;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function legacyCapabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false }
  };
}

export function modernCapabilities(): Record<string, unknown> {
  return {
    tools: {},
    resources: {},
    prompts: {}
  };
}

export function negotiateLegacyProtocolVersion(params: unknown): string {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.some(version => version === requested)
    ? requested
    : PREFERRED_LEGACY_PROTOCOL_VERSION;
}

function invalidParams(id: string | number | null, message: string): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message
    }
  };
}

export function classifyProtocolRequest(
  req: JSONRPCRequest,
  id: string | number | null
): ProtocolClassification {
  const params = isRecord(req.params) ? req.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const hasModernVersionMarker = !!meta && Object.hasOwn(meta, PROTOCOL_VERSION_META_KEY);
  const isModernCandidate = req.method === 'server/discover' || hasModernVersionMarker;

  if (!isModernCandidate) return { era: 'legacy' };

  if (!params || !meta) {
    return {
      era: 'modern',
      error: invalidParams(
        id,
        'Invalid params: modern MCP requests require a params._meta object'
      )
    };
  }

  const requestedVersion = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof requestedVersion !== 'string') {
    return {
      era: 'modern',
      error: invalidParams(
        id,
        `Invalid params: ${PROTOCOL_VERSION_META_KEY} must be a string`
      )
    };
  }

  if (requestedVersion !== MODERN_PROTOCOL_VERSION) {
    return {
      era: 'modern',
      error: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32022,
          message: `Unsupported MCP protocol version: ${requestedVersion}`,
          data: {
            supported: [MODERN_PROTOCOL_VERSION],
            requested: requestedVersion
          }
        }
      }
    };
  }

  if (!isRecord(meta[CLIENT_CAPABILITIES_META_KEY])) {
    return {
      era: 'modern',
      error: invalidParams(
        id,
        `Invalid params: ${CLIENT_CAPABILITIES_META_KEY} must be an object`
      )
    };
  }

  const clientInfo = meta[CLIENT_INFO_META_KEY];
  if (
    clientInfo !== undefined &&
    (!isRecord(clientInfo) ||
      typeof clientInfo.name !== 'string' ||
      typeof clientInfo.version !== 'string')
  ) {
    return {
      era: 'modern',
      error: invalidParams(
        id,
        `Invalid params: ${CLIENT_INFO_META_KEY} must contain string name and version fields`
      )
    };
  }

  return { era: 'modern' };
}

export function stampModernSuccess(
  response: JSONRPCResponse,
  method: string
): JSONRPCResponse {
  if (!isRecord(response.result)) return response;

  const existingMeta = isRecord(response.result._meta) ? response.result._meta : {};
  const result: Record<string, any> = {
    ...response.result,
    resultType: 'complete',
    _meta: {
      ...existingMeta,
      [SERVER_INFO_META_KEY]: SERVER_INFO
    }
  };

  if (method === 'server/discover') {
    result.ttlMs = 3_600_000;
    result.cacheScope = 'public';
  } else if (['tools/list', 'resources/list', 'prompts/list'].includes(method)) {
    result.ttlMs = 300_000;
    result.cacheScope = 'public';
  }

  return {
    ...response,
    result
  };
}
