export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07'
];
export const PREFERRED_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

export const REMOTE_SERVER_INFO = Object.freeze({
  name: '@nymrel/remote-control',
  version: '0.1.0'
});

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidParams(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

export function classifyProtocolRequest(req, id = req?.id ?? null) {
  const params = isRecord(req?.params) ? req.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const modernMarker = !!meta && Object.hasOwn(meta, PROTOCOL_VERSION_META_KEY);
  const modern = req?.method === 'server/discover' || modernMarker;
  if (!modern) return { era: 'legacy' };
  if (!params || !meta) {
    return { era: 'modern', error: invalidParams(id, 'Modern MCP requests require params._meta') };
  }
  const version = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof version !== 'string') {
    return { era: 'modern', error: invalidParams(id, `${PROTOCOL_VERSION_META_KEY} must be a string`) };
  }
  if (version !== MODERN_PROTOCOL_VERSION) {
    return {
      era: 'modern',
      error: {
        jsonrpc: '2.0', id,
        error: {
          code: -32022,
          message: `Unsupported MCP protocol version: ${version}`,
          data: { supported: [MODERN_PROTOCOL_VERSION], requested: version }
        }
      }
    };
  }
  if (!isRecord(meta[CLIENT_CAPABILITIES_META_KEY])) {
    return { era: 'modern', error: invalidParams(id, `${CLIENT_CAPABILITIES_META_KEY} must be an object`) };
  }
  const clientInfo = meta[CLIENT_INFO_META_KEY];
  if (clientInfo !== undefined && (!isRecord(clientInfo) || typeof clientInfo.name !== 'string' || typeof clientInfo.version !== 'string')) {
    return { era: 'modern', error: invalidParams(id, `${CLIENT_INFO_META_KEY} must contain string name and version`) };
  }
  return { era: 'modern' };
}

export function negotiateLegacyProtocolVersion(params) {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PREFERRED_LEGACY_PROTOCOL_VERSION;
}

export function stampModernSuccess(response, method) {
  if (!isRecord(response?.result)) return response;
  const existingMeta = isRecord(response.result._meta) ? response.result._meta : {};
  const result = {
    ...response.result,
    resultType: response.result.resultType || 'complete',
    _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: REMOTE_SERVER_INFO }
  };
  if (method === 'server/discover') {
    result.ttlMs = 3600000;
    result.cacheScope = 'public';
  } else if (method === 'tools/list') {
    // Dynamic because the device fleet and schemas can change.
    result.ttlMs = 5000;
    result.cacheScope = 'private';
  }
  return { ...response, result };
}
