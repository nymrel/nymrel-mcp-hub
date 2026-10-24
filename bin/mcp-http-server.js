#!/usr/bin/env node
import {
  DEFAULT_DRAIN_TIMEOUT_MS,
  drainMCPHttpServer,
  startMCPHttpServer
} from '../dist/src/http.js';

function csv(name) {
  const value = process.env[name] ?? '';
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    process.stderr.write(`[nymrel-mcp-http] ${name} must be a positive integer\n`);
    process.exit(2);
  }
  return value;
}

const host = process.env.NYMREL_MCP_HTTP_HOST ?? '127.0.0.1';
const rawPort = process.env.NYMREL_MCP_HTTP_PORT ?? '8787';
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('[nymrel-mcp-http] NYMREL_MCP_HTTP_PORT must be an integer from 1 to 65535\n');
  process.exit(2);
}

const allowedHosts = csv('NYMREL_MCP_HTTP_ALLOWED_HOSTS');
const allowedOrigins = csv('NYMREL_MCP_HTTP_ALLOWED_ORIGINS');
const bearerToken = process.env.NYMREL_MCP_HTTP_BEARER_TOKEN;
const nonLoopback = !['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());

if (nonLoopback && allowedHosts.length === 0) {
  process.stderr.write('[nymrel-mcp-http] non-loopback binding requires NYMREL_MCP_HTTP_ALLOWED_HOSTS\n');
  process.exit(2);
}
if (nonLoopback && !bearerToken) {
  process.stderr.write('[nymrel-mcp-http] non-loopback binding requires NYMREL_MCP_HTTP_BEARER_TOKEN\n');
  process.exit(2);
}

const drainTimeoutMs = integerEnv('NYMREL_MCP_HTTP_DRAIN_TIMEOUT_MS', DEFAULT_DRAIN_TIMEOUT_MS);
const server = startMCPHttpServer({
  host,
  port,
  allowedHosts,
  allowedOrigins,
  bearerToken,
  maxBodyBytes: integerEnv('NYMREL_MCP_HTTP_MAX_BODY_BYTES', undefined),
  maxResponseBytes: integerEnv('NYMREL_MCP_HTTP_MAX_RESPONSE_BYTES', undefined),
  requestTimeoutMs: integerEnv('NYMREL_MCP_HTTP_REQUEST_TIMEOUT_MS', undefined),
  maxConcurrentRequests: integerEnv('NYMREL_MCP_HTTP_MAX_CONCURRENT_REQUESTS', undefined),
  rateLimitWindowMs: integerEnv('NYMREL_MCP_HTTP_RATE_LIMIT_WINDOW_MS', undefined),
  rateLimitMaxRequests: integerEnv('NYMREL_MCP_HTTP_RATE_LIMIT_MAX_REQUESTS', undefined),
  maxJsonDepth: integerEnv('NYMREL_MCP_HTTP_MAX_JSON_DEPTH', undefined)
});

process.stderr.write(`[nymrel-mcp-http] listening on http://${host}:${port}/mcp\n`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const result = await drainMCPHttpServer(server, drainTimeoutMs);
    process.stderr.write(
      `[nymrel-mcp-http] ${signal} drain complete (forced=${String(result.forced)})\n`
    );
  } catch (error) {
    process.stderr.write(
      `[nymrel-mcp-http] drain failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
