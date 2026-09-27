#!/usr/bin/env node
import { startMCPHttpServer } from '../dist/src/http.js';

function csv(name) {
  const value = process.env[name] ?? '';
  return value.split(',').map((item) => item.trim()).filter(Boolean);
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

if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && allowedHosts.length === 0) {
  process.stderr.write('[nymrel-mcp-http] non-loopback binding requires NYMREL_MCP_HTTP_ALLOWED_HOSTS\n');
  process.exit(2);
}

startMCPHttpServer({
  host,
  port,
  allowedHosts,
  allowedOrigins,
  bearerToken
});

process.stderr.write(`[nymrel-mcp-http] listening on http://${host}:${port}/mcp\n`);
