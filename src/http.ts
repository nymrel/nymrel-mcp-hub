/**
 * Stateless MCP Streamable HTTP adapter for the Amazon Alexa+ hackathon lane.
 *
 * This transport is intentionally isolated from the stdio server. It serves only
 * the 2025-11-25 handshake-era protocol over JSON responses and exposes a
 * reviewed hosted-tool allowlist. It does not assign Mcp-Session-Id; the
 * 2025-11-25 transport permits servers to remain stateless when they do not need
 * server-to-client requests or resumability.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MCPServer } from './server.js';
import type { JSONRPCRequest, JSONRPCResponse } from './types/index.js';

export const HTTP_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_HTTP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
export const DEFAULT_MAX_JSON_DEPTH = 32;
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export const DEFAULT_HOSTED_TOOL_ALLOWLIST = Object.freeze([
  'nymrel_ucp_audit',
  'nymrel_surety_guard',
  'nymrel_machine_trust',
  'nymrel_proof_verify'
] as const);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface MCPHttpOptions {
  path?: string;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  maxJsonDepth?: number;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  bearerToken?: string;
  hostedToolAllowlist?: readonly string[];
}

export interface MCPHttpListenOptions extends MCPHttpOptions {
  host?: string;
  port?: number;
}

export interface MCPHttpDrainResult {
  forced: boolean;
}

export type MCPHttpHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  activeRequestCount: () => number;
};

class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out');
  }
}

const serverState = new WeakMap<Server, { handler: MCPHttpHandler }>();

function positiveInteger(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
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

function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase());
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeRawJson(
  res: ServerResponse,
  statusCode: number,
  body: string,
  extraHeaders: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  maxResponseBytes: number,
  extraHeaders: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) <= maxResponseBytes) {
    writeRawJson(res, statusCode, body, extraHeaders);
    return;
  }

  const boundedError = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32024,
      message: 'Response body exceeds configured limit'
    }
  });
  writeRawJson(res, 500, boundedError, {
    connection: 'close'
  });
}

function writeTransportError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  maxResponseBytes: number,
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
    maxResponseBytes,
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

function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  hostHeader: string | undefined
): boolean {
  if (!origin) return true;
  if (allowedOrigins.some((allowed) => allowed.trim() === origin)) return true;

  try {
    const parsed = new URL(origin);
    const normalizedHost = hostHeader?.trim().toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host.toLowerCase() === normalizedHost
    );
  } catch {
    return false;
  }
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

function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const { value: item, depth } = current;
    if (!item || typeof item !== 'object') continue;
    if (depth > maxDepth) return true;

    const children = Array.isArray(item) ? item : Object.values(item as Record<string, unknown>);
    for (const child of children) {
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return false;
}

async function readBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);

      if (error) {
        req.pause();
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        finish(new RangeError('Request body exceeds configured limit'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new Error('Request aborted'));

    const timer = setTimeout(() => finish(new RequestTimeoutError()), timeoutMs);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

export function createMCPHttpHandler(options: MCPHttpOptions = {}): MCPHttpHandler {
  const path = options.path ?? DEFAULT_HTTP_PATH;
  const maxBodyBytes = positiveInteger('maxBodyBytes', options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const maxResponseBytes = positiveInteger(
    'maxResponseBytes',
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    256
  );
  const requestTimeoutMs = positiveInteger(
    'requestTimeoutMs',
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  const maxConcurrentRequests = positiveInteger(
    'maxConcurrentRequests',
    options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
  );
  const rateLimitWindowMs = positiveInteger(
    'rateLimitWindowMs',
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS
  );
  const rateLimitMaxRequests = positiveInteger(
    'rateLimitMaxRequests',
    options.rateLimitMaxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS
  );
  const maxJsonDepth = positiveInteger(
    'maxJsonDepth',
    options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH
  );
  const allowedHosts = options.allowedHosts ?? [];
  const allowedOrigins = options.allowedOrigins ?? [];
  const hostedToolAllowlist = new Set(options.hostedToolAllowlist ?? DEFAULT_HOSTED_TOOL_ALLOWLIST);
  const core = new MCPServer();

  let activeRequests = 0;
  let rateWindowStartedAt = Date.now();
  let rateWindowCount = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');

    if (requestUrl.pathname !== path) {
      writeTransportError(res, 404, 'Not found', maxResponseBytes);
      return;
    }

    const host = firstHeader(req.headers.host);
    if (!isAllowedHost(host, allowedHosts)) {
      writeTransportError(res, 403, 'Host not allowed', maxResponseBytes);
      return;
    }

    const origin = firstHeader(req.headers.origin);
    if (!isAllowedOrigin(origin, allowedOrigins, host)) {
      writeTransportError(res, 403, 'Origin not allowed', maxResponseBytes);
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
      writeTransportError(res, 405, 'Only POST is supported', maxResponseBytes, {
        allow: 'POST, OPTIONS'
      });
      return;
    }

    const now = Date.now();
    if (now - rateWindowStartedAt >= rateLimitWindowMs) {
      rateWindowStartedAt = now;
      rateWindowCount = 0;
    }
    if (rateWindowCount >= rateLimitMaxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((rateLimitWindowMs - (now - rateWindowStartedAt)) / 1000)
      );
      writeTransportError(res, 429, 'Rate limit exceeded', maxResponseBytes, {
        'retry-after': String(retryAfterSeconds)
      });
      return;
    }
    rateWindowCount += 1;

    if (activeRequests >= maxConcurrentRequests) {
      writeTransportError(res, 503, 'Too many concurrent requests', maxResponseBytes, {
        'retry-after': '1'
      });
      return;
    }

    activeRequests += 1;
    try {
      if (options.bearerToken) {
        const authorization = firstHeader(req.headers.authorization);
        const prefix = 'Bearer ';
        const candidate = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : '';
        if (!candidate || !safeTokenEqual(candidate, options.bearerToken)) {
          writeTransportError(res, 401, 'Unauthorized', maxResponseBytes, {
            'www-authenticate': 'Bearer realm="nymrel-mcp"'
          });
          return;
        }
      }

      if (!isJsonContentType(firstHeader(req.headers['content-type']))) {
        writeTransportError(res, 415, 'Content-Type must be application/json', maxResponseBytes);
        return;
      }

      if (!acceptsJson(firstHeader(req.headers.accept))) {
        writeTransportError(res, 406, 'Client must accept application/json', maxResponseBytes);
        return;
      }

      let body: string;
      try {
        body = await readBody(req, maxBodyBytes, requestTimeoutMs);
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          writeTransportError(res, 504, 'Request timed out', maxResponseBytes, {
            connection: 'close'
          });
          return;
        }
        if (error instanceof RangeError) {
          writeTransportError(res, 413, 'Request body too large', maxResponseBytes, {
            connection: 'close'
          });
          return;
        }
        writeTransportError(res, 400, 'Unable to read request body', maxResponseBytes, {
          connection: 'close'
        });
        return;
      }

      let rpcRequest: JSONRPCRequest;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (exceedsJsonDepth(parsed, maxJsonDepth)) {
          writeTransportError(res, 400, 'Request JSON exceeds configured nesting limit', maxResponseBytes);
          return;
        }
        rpcRequest = parsed as JSONRPCRequest;
      } catch {
        writeJson(
          res,
          400,
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error'
            }
          },
          maxResponseBytes
        );
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
            ),
            maxResponseBytes
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
            ),
            maxResponseBytes
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
          writeJson(
            res,
            200,
            {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Tool is not available over hosted transport: ${toolName}`
              }
            },
            maxResponseBytes
          );
          return;
        }
      }

      let coreResponse: JSONRPCResponse | null;
      try {
        coreResponse = await withTimeout(core.handleRequest(rpcRequest), requestTimeoutMs);
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          writeTransportError(res, 504, 'Request timed out', maxResponseBytes, {
            connection: 'close'
          });
          return;
        }
        throw error;
      }

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

      writeJson(res, 200, response, maxResponseBytes);
    } finally {
      activeRequests -= 1;
    }
  };

  return Object.assign(handler, {
    activeRequestCount: () => activeRequests
  });
}

export function startMCPHttpServer(options: MCPHttpListenOptions = {}): Server {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const requestTimeoutMs = positiveInteger(
    'requestTimeoutMs',
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );

  if (!isLoopbackBindHost(host) && !options.bearerToken) {
    throw new Error('Non-loopback MCP HTTP hosting requires bearer authentication');
  }

  const handler = createMCPHttpHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        writeTransportError(
          res,
          500,
          'Internal server error',
          options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
        );
      } else {
        res.destroy();
      }
    });
  });

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = Math.min(5_000, requestTimeoutMs);
  serverState.set(server, { handler });
  server.listen(port, host);
  return server;
}

export async function drainMCPHttpServer(
  server: Server,
  timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS
): Promise<MCPHttpDrainResult> {
  const timeout = positiveInteger('drainTimeoutMs', timeoutMs);
  const state = serverState.get(server);

  let closeError: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    server.close((error) => {
      closeError = error ?? undefined;
      resolve();
    });
  });
  server.closeIdleConnections();

  const deadline = Date.now() + timeout;
  while ((state?.handler.activeRequestCount() ?? 0) > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));
    });
  }

  const forced = (state?.handler.activeRequestCount() ?? 0) > 0;
  if (forced) {
    server.closeAllConnections();
  }
  await closed;

  if (closeError && (closeError as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
    throw closeError;
  }

  return { forced };
}
