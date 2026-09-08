import { collectMcpHeaderBindings } from './schema.js';
import { isRecord, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from './mcp-protocol.js';

const SENTINEL_RE = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;

function headerValue(headers, name) {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function decodeMcpHeaderValue(raw) {
  if (typeof raw !== 'string') throw new Error('Header is missing');
  const sentinel = SENTINEL_RE.exec(raw);
  if (sentinel) {
    const encoded = sentinel[1];
    if (encoded.length % 4 !== 0) throw new Error('Invalid base64 header encoding');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('Non-canonical base64 header encoding');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Header is not valid UTF-8');
    return text;
  }
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (!((code >= 0x20 && code <= 0x7e) || code === 0x09)) throw new Error('Header contains invalid characters');
  }
  if (raw !== raw.trim()) throw new Error('Header with leading/trailing whitespace must be base64 encoded');
  if (raw.startsWith('=?base64?') && raw.endsWith('?=')) throw new Error('Sentinel-like literal must be base64 encoded');
  return raw;
}

function getAtPath(value, path) {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function comparePrimitive(type, decoded, actual) {
  if (type === 'string') return typeof actual === 'string' && decoded === actual;
  if (type === 'boolean') return typeof actual === 'boolean' && decoded === String(actual).toLowerCase();
  if (type === 'integer') {
    if (!Number.isSafeInteger(actual)) return false;
    if (!/^-?(0|[1-9][0-9]*)$/.test(decoded)) return false;
    const parsed = Number(decoded);
    return Number.isSafeInteger(parsed) && parsed === actual;
  }
  return false;
}

export class HeaderMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HeaderMismatchError';
    this.code = -32020;
  }
}

export function isModernMcpRequest(body) {
  const meta = isRecord(body?.params) && isRecord(body.params._meta) ? body.params._meta : null;
  return body?.method === 'server/discover' || meta?.[PROTOCOL_VERSION_META_KEY] === MODERN_PROTOCOL_VERSION;
}

export function validateModernMcpHeaders(headers, body, toolInputSchema = null) {
  const meta = isRecord(body?.params) && isRecord(body.params._meta) ? body.params._meta : {};
  const bodyVersion = meta[PROTOCOL_VERSION_META_KEY];
  const protocolHeader = headerValue(headers, 'mcp-protocol-version');
  const methodHeader = headerValue(headers, 'mcp-method');

  if (!protocolHeader) throw new HeaderMismatchError('Missing MCP-Protocol-Version header');
  if (protocolHeader !== bodyVersion) throw new HeaderMismatchError('MCP-Protocol-Version header does not match request metadata');
  if (!methodHeader) throw new HeaderMismatchError('Missing Mcp-Method header');
  if (methodHeader !== body.method) throw new HeaderMismatchError('Mcp-Method header does not match request method');

  if (body.method === 'tools/call') {
    const bodyName = body?.params?.name;
    const rawName = headerValue(headers, 'mcp-name');
    if (!rawName) throw new HeaderMismatchError('Missing Mcp-Name header');
    let decodedName;
    try { decodedName = decodeMcpHeaderValue(rawName); } catch (error) { throw new HeaderMismatchError(`Invalid Mcp-Name header: ${error.message}`); }
    if (decodedName !== bodyName) throw new HeaderMismatchError('Mcp-Name header does not match tool name');

    if (toolInputSchema) {
      const bindings = collectMcpHeaderBindings(toolInputSchema);
      const args = isRecord(body?.params?.arguments) ? body.params.arguments : {};
      for (const binding of bindings) {
        const actual = getAtPath(args, binding.path);
        const raw = headerValue(headers, `mcp-param-${binding.headerName}`);
        if (actual === undefined || actual === null) {
          if (raw !== undefined) throw new HeaderMismatchError(`Mcp-Param-${binding.headerName} must be omitted when the parameter is absent or null`);
          continue;
        }
        if (raw === undefined) throw new HeaderMismatchError(`Missing Mcp-Param-${binding.headerName} header`);
        let decoded;
        try { decoded = decodeMcpHeaderValue(raw); } catch (error) { throw new HeaderMismatchError(`Invalid Mcp-Param-${binding.headerName}: ${error.message}`); }
        if (!comparePrimitive(binding.type, decoded, actual)) {
          throw new HeaderMismatchError(`Mcp-Param-${binding.headerName} does not match the request body`);
        }
      }
    }
  }
}
