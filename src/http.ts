/**
 * Stateless MCP Streamable HTTP adapter for the Amazon Alexa+ hackathon lane.
 *
 * This transport is intentionally isolated from the stdio server. It serves only
 * the 2025-11-25 handshake-era protocol over JSON responses and exposes a
 * reviewed hosted-tool allowlist. It does not assign Mcp-Session-Id; the
 * 2025-11-25 transport permits servers to remain stateless when they do not need
 * server-to-client requests or resumability.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MCPServer } from './server.js';
import type { JSONRPCRequest, JSONRPCResponse } from './types/index.js';

export const HTTP_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_HTTP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export const DEFAULT_HOSTED_TOOL_ALLOWLIST = Object.freeze([
  'nymrel_ucp_audit',
  'nymrel_surety_guard',
  'nymrel_machine_trust',
  'nymrel_proof_verify'
] as const);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface MCPHttpOptions {
  path?: string;
  maxBodyBytes?: number;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  bearerToken?: string;
  hostedToolAllowlist?: readonly string[];
}

export interface MCPHttpListenOptions extends MCPHttpOptions {
  host?: string;
  port?: number;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bareHost(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end >= 0 ? hostHeader.slice(0, end + 1).toLowerCase() : hostHeader.toLowerCase();
  }
  return hostHeader.split(':', 1)[0]?.toLowerCase();
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function writeTransportError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): void {
  writeJson(
    res,
    statusCode,
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message
      }
    },
    extraHeaders
  );
}

function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  const host = bareHost(hostHeader);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;

  const normalizedHeader = hostHeader?.toLowerCase();
  return allowedHosts.some((allowed) => {
    const normalized = allowed.trim().toLowerCase();
    return normalized.length > 0 && (normalized === host || normalized === normalizedHeader);
  });
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.some((allowed) => allowed.trim() === origin);
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function acceptsJson(accept: string | undefined): boolean {
  if (!accept || accept.trim() === '*/*') return true;
  return accept
    .split(',')
    .map((part) => part.split(';', 1)[0]?.trim().toLowerCase())
    .some((mediaType) => mediaType === 'application/json' || mediaType === '*/*');
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new RangeError('Request body exceeds configured limit');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function protocolError(
  id: string | number | null,
  message: string,
  code = -32022
): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data: {
        supported: [HTTP_PROTOCOL_VERSION]
      }
    }
  };
}

function requestId(req: JSONRPCRequest): string | number | null {
  return Object.hasOwn(req, 'id') ? (req.id ?? null) : null;
}

function filterHostedTools(
  response: JSONRPCResponse,
  allowlist: ReadonlySet<string>
): JSONRPCResponse {
  if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
    return response;
  }

  const tools = (response.result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return response;

  return {
    ...response,
    result: {
      ...(response.result as Record<string, unknown>),
      tools: tools.filter((tool) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
        const name = (tool as Record<string, unknown>).name;
        return typeof name === 'string' && allowlist.has(name);
      })
    }
  };
}

export function createMCPHttpHandler(options: MCPHttpOptions = {}) {
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedHosts = options.allowedHosts ?? [];
  const allowedOrigins = options.allowedOrigins ?? [];
  const hostedToolAllowlist = new Set(options.hostedToolAllowlist ?? DEFAULT_HOSTED_TOOL_ALLOWLIST);
  const core = new MCPServer();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');

    if (requestUrl.pathname !== path) {
      writeTransportError(res, 404, 'Not found');
      return;
    }

    const host = firstHeader(req.headers.host);
    if (!isAllowedHost(host, allowedHosts)) {
      writeTransportError(res, 403, 'Host not allowed');
      return;
    }

    const origin = firstHeader(req.headers.origin);
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      writeTransportError(res, 403, 'Origin not allowed');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        allow: 'POST, OPTIONS',
        'cache-control': 'no-store'
      });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      writeTransportError(res, 405, 'Only POST is supported', { allow: 'POST, OPTIONS' });
      return;
    }

    if (options.bearerToken) {
      const authorization = firstHeader(req.headers.authorization);
      const prefix = 'Bearer ';
      const candidate = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : '';
      if (!candidate || !safeTokenEqual(candidate, options.bearerToken)) {
        writeTransportError(res, 401, 'Unauthorized', {
          'www-authenticate': 'Bearer realm="nymrel-mcp"'
        });
        return;
      }
    }

    if (!isJsonContentType(firstHeader(req.headers['content-type']))) {
      writeTransportError(res, 415, 'Content-Type must be application/json');
      return;
    }

    if (!acceptsJson(firstHeader(req.headers.accept))) {
      writeTransportError(res, 406, 'Client must accept application/json');
      return;
    }

    let body: string;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof RangeError) {
        writeTransportError(res, 413, 'Request body too large');
        return;
      }
      writeTransportError(res, 400, 'Unable to read request body');
      return;
    }

    let rpcRequest: JSONRPCRequest;
    try {
      rpcRequest = JSON.parse(body) as JSONRPCRequest;
    } catch {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error'
        }
      });
      return;
    }

    const id = requestId(rpcRequest);

    if (rpcRequest.method === 'initialize') {
      const requested =
        rpcRequest.params &&
        typeof rpcRequest.params === 'object' &&
        !Array.isArray(rpcRequest.params) &&
        typeof (rpcRequest.params as Record<string, unknown>).protocolVersion === 'string'
          ? (rpcRequest.params as Record<string, unknown>).protocolVersion
          : undefined;

      if (requested !== HTTP_PROTOCOL_VERSION) {
        writeJson(
          res,
          200,
          protocolError(
            id,
            `Unsupported MCP protocol version on HTTP transport: ${String(requested ?? 'missing')}`
          )
        );
        return;
      }
    } else {
      const headerVersion = firstHeader(req.headers['mcp-protocol-version']);
      if (headerVersion !== HTTP_PROTOCOL_VERSION) {
        writeJson(
          res,
          400,
          protocolError(
            id,
            `MCP-Protocol-Version must be ${HTTP_PROTOCOL_VERSION} for HTTP requests`
          )
        );
        return;
      }
    }

    if (
      rpcRequest.method === 'tools/call' &&
      rpcRequest.params &&
      typeof rpcRequest.params === 'object' &&
      !Array.isArray(rpcRequest.params)
    ) {
      const toolName = (rpcRequest.params as Record<string, unknown>).name;
      if (typeof toolName === 'string' && !hostedToolAllowlist.has(toolName)) {
        writeJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: `Tool is not available over hosted transport: ${toolName}`
          }
        });
        return;
      }
    }

    const coreResponse = await core.handleRequest(rpcRequest);

    if (coreResponse === null) {
      res.writeHead(202, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end();
      return;
    }

    const response =
      rpcRequest.method === 'tools/list'
        ? filterHostedTools(coreResponse, hostedToolAllowlist)
        : coreResponse;

    writeJson(res, 200, response);
  };
}

export function startMCPHttpServer(options: MCPHttpListenOptions = {}): Server {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const handler = createMCPHttpHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        writeTransportError(res, 500, 'Internal server error');
      } else {
        res.destroy();
      }
    });
  });
  server.listen(port, host);
  return server;
}
