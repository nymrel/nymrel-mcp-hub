import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLedger } from './audit.js';
import { RemoteBroker } from './broker.js';
import { EnvelopeCipher, constantTimeEqual, randomId } from './crypto.js';
import { NymrelRemoteError, UnauthorizedError } from './errors.js';
import { RemoteMcpEdge } from './mcp-edge.js';
import { HeaderMismatchError, isModernMcpRequest, validateModernMcpHeaders } from './mcp-http-validation.js';
import { OAuthAccessTokenVerifier } from './oauth.js';
import { PolicyEngine } from './policy.js';
import { JsonFileStore } from './store.js';
import { InstanceLease } from './instance-lease.js';
import { TokenService, bearerFromHeaders } from './token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../public');
const USER_SCOPE_ALLOWLIST = new Set([
  'devices:pair', 'devices:read', 'devices:revoke',
  'calls:read', 'calls:approve', 'audit:read',
  'tools:read', 'tools:write', 'tools:execute', 'tools:network', 'tools:*', '*'
]);
const BASIC_MCP_SCOPES = ['devices:read', 'calls:read', 'tools:read'];

function sendJson(res, status, value, headers = {}) {
  const payload = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function errorBody(error) {
  if (error instanceof NymrelRemoteError) {
    return { error: { code: error.code, message: error.message, ...(error.data ? { details: error.data } : {}) } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Request body exceeds configured limit');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Malformed JSON body'); error.status = 400; throw error; }
  return parsed;
}

function remoteIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

class FixedWindowRateLimiter {
  constructor() { this.entries = new Map(); }
  take(key, limit, windowMs = 60_000) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > 5000) {
      for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);
    }
    return { allowed: entry.count <= limit, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
}

function extractRequiredScope(message) {
  const match = /^([^ ]+) scope required$/.exec(String(message || ''));
  return match?.[1] || null;
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set(config.allowedOrigins);
  if (config.publicBaseUrl) {
    try { allowed.add(new URL(config.publicBaseUrl).origin); } catch { /* validated by URL consumers later */ }
  }
  if (!config.production) {
    allowed.add(`http://127.0.0.1:${config.port}`);
    allowed.add(`http://localhost:${config.port}`);
  }
  return allowed.has(origin);
}

function resourceMetadataUrl(config) {
  if (!config.publicBaseUrl) return `http://${config.host}:${config.port}/.well-known/oauth-protected-resource`;
  return `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
}

function mcpResource(config) {
  if (!config.publicBaseUrl) return `http://${config.host}:${config.port}/mcp`;
  return `${config.publicBaseUrl}/mcp`;
}

function bearerChallenge(config, { scope = BASIC_MCP_SCOPES.join(' '), insufficient = false } = {}) {
  const parts = [];
  if (insufficient) parts.push('error="insufficient_scope"');
  if (scope) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl(config)}"`);
  return `Bearer ${parts.join(', ')}`;
}

function validateAcceptForModern(req) {
  const accept = String(req.headers.accept || '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    throw new HeaderMismatchError('Modern MCP requests must Accept both application/json and text/event-stream');
  }
}

export async function createRemoteRuntime(config, { publicDir = DEFAULT_PUBLIC_DIR, logger = console } = {}) {
  const store = await new JsonFileStore(config.storePath).init();
  const instanceLease = config.production
    ? await new InstanceLease(`${config.storePath}.server-lease`, { ttlMs: config.instanceLeaseTtlMs, logger }).acquire()
    : null;
  const tokenService = new TokenService(config.signingKey);
  const cipher = new EnvelopeCipher(config.dataKey);
  const audit = new AuditLedger(config.auditKey);
  const policy = new PolicyEngine();
  const broker = await new RemoteBroker({ store, tokenService, cipher, audit, policy, config }).init();
  const mcp = new RemoteMcpEdge({ broker, syncWaitMs: config.syncWaitMs });
  const oauth = new OAuthAccessTokenVerifier({
    issuer: config.oauthIssuer,
    jwksUrl: config.oauthJwksUrl,
    audience: config.oauthAudience || mcpResource(config),
    tenantClaim: config.oauthTenantClaim,
    introspectionUrl: config.oauthIntrospectionUrl,
    introspectionClientId: config.oauthIntrospectionClientId,
    introspectionClientSecret: config.oauthIntrospectionClientSecret
  });
  return { config, store, tokenService, cipher, audit, policy, broker, mcp, oauth, instanceLease, publicDir, logger };
}

export async function createRemoteHttpServer(config, options = {}) {
  const runtime = options.runtime || await createRemoteRuntime(config, options);
  const limiter = new FixedWindowRateLimiter();
  const deviceStreams = new Map();

  const sendDoorbell = ({ deviceId, callId }) => {
    const clients = deviceStreams.get(deviceId);
    if (!clients) return;
    const data = `event: call\ndata: ${JSON.stringify({ type: 'call', callId })}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { /* closed stream cleanup handles it */ }
    }
  };
  runtime.broker.on('call', sendDoorbell);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = randomId('req_');
    let statusForLog = 500;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-resource-policy', 'same-origin');

    const finishLog = () => runtime.logger.info?.(`${req.method} ${new URL(req.url, 'http://local').pathname} ${statusForLog} ${Date.now() - started}ms ${requestId}`);
    res.once('finish', finishLog);

    try {
      if (!originAllowed(req, config)) {
        statusForLog = 403;
        return sendJson(res, 403, { error: { code: 'ORIGIN_DENIED', message: 'Origin is not allowed' } });
      }

      const url = new URL(req.url, 'http://local');
      const pathname = url.pathname;
      const ip = remoteIp(req);
      const bucket = pathname.startsWith('/v1/pairings/') ? 'pair' : pathname === '/mcp' ? 'mcp' : 'api';
      const limit = bucket === 'pair' ? 120 : bucket === 'mcp' ? 600 : 300;
      const rate = limiter.take(`${ip}:${bucket}`, limit);
      if (!rate.allowed) {
        statusForLog = 429;
        return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, { 'retry-after': String(rate.retryAfterSec) });
      }

      if (pathname === '/healthz' && req.method === 'GET') {
        statusForLog = 200;
        return sendJson(res, 200, { status: 'ok' });
      }
      if (pathname === '/readyz' && req.method === 'GET') {
        const state = await runtime.store.read();
        const auditStatus = runtime.audit.verify(state.receipts);
        statusForLog = auditStatus.valid ? 200 : 503;
        return sendJson(res, statusForLog, { status: auditStatus.valid ? 'ready' : 'degraded', revision: state.revision, audit: auditStatus });
      }

      if ((pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') {
        statusForLog = 200;
        return sendJson(res, 200, {
          resource: mcpResource(config),
          authorization_servers: config.authorizationServers,
          scopes_supported: BASIC_MCP_SCOPES,
          bearer_methods_supported: ['header']
        }, { 'cache-control': 'public, max-age=300' });
      }

      if (pathname === '/' && req.method === 'GET') {
        const html = await fs.readFile(path.join(runtime.publicDir, 'index.html'), 'utf8');
        statusForLog = 200;
        return sendText(res, 200, html, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'cache-control': 'no-store'
        });
      }
      if (pathname === '/app.js' && req.method === 'GET') {
        const js = await fs.readFile(path.join(runtime.publicDir, 'app.js'), 'utf8');
        statusForLog = 200;
        return sendText(res, 200, js, 'text/javascript; charset=utf-8', { 'cache-control': 'no-store' });
      }
      if (pathname === '/styles.css' && req.method === 'GET') {
        const css = await fs.readFile(path.join(runtime.publicDir, 'styles.css'), 'utf8');
        statusForLog = 200;
        return sendText(res, 200, css, 'text/css; charset=utf-8', { 'cache-control': 'no-store' });
      }

      if (pathname === '/v1/pairings/start' && req.method === 'POST') {
        const stricter = limiter.take(`${ip}:pair-start`, 30);
        if (!stricter.allowed) {
          statusForLog = 429;
          return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many pairing attempts' } }, { 'retry-after': String(stricter.retryAfterSec) });
        }
        const body = await readJson(req, 16 * 1024);
        const result = await runtime.broker.startPairing(body);
        statusForLog = 201;
        return sendJson(res, 201, result, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/pairings/poll' && req.method === 'POST') {
        const body = await readJson(req, 16 * 1024);
        const result = await runtime.broker.pollPairing(body.device_code);
        statusForLog = 200;
        return sendJson(res, 200, result, { 'cache-control': 'no-store' });
      }

      if (pathname === '/v1/admin/tokens' && req.method === 'POST') {
        if (!config.allowBootstrapHttp) {
          statusForLog = 404;
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
        }
        const token = bearerFromHeaders(req.headers);
        if (!constantTimeEqual(token, config.bootstrapToken)) throw new UnauthorizedError('Bootstrap credential required');
        const body = await readJson(req, 32 * 1024);
        if (typeof body.subject !== 'string' || !body.subject || body.subject.length > 256) throw new Error('subject is required');
        const scopes = Array.isArray(body.scopes) ? body.scopes : [];
        if (scopes.some((scope) => !USER_SCOPE_ALLOWLIST.has(scope))) throw new Error('One or more scopes are not allowed');
        const ttlSec = Number.isInteger(body.ttlSec) ? Math.max(60, Math.min(24 * 60 * 60, body.ttlSec)) : 3600;
        const minted = runtime.tokenService.mint({
          subject: body.subject,
          tenantId: typeof body.tenantId === 'string' && body.tenantId ? body.tenantId : 'default',
          scopes,
          type: 'user',
          ttlSec
        });
        statusForLog = 201;
        return sendJson(res, 201, { access_token: minted, token_type: 'Bearer', expires_in: ttlSec, scope: scopes.join(' ') }, { 'cache-control': 'no-store' });
      }

      const internalUser = async () => {
        const token = bearerFromHeaders(req.headers);
        if (!token) throw new UnauthorizedError('Bearer token required');
        if (config.authorizationServers.length > 0) {
          try { return await runtime.oauth.verify(token); } catch { /* optional internal fallback below */ }
        }
        if (config.allowStaticAdminTokens) {
          try { return runtime.tokenService.verify(token, { expectedType: 'user' }); } catch { /* handled below */ }
        }
        throw new UnauthorizedError('Invalid or expired operator bearer token');
      };
      const mcpUser = async () => {
        const token = bearerFromHeaders(req.headers);
        if (!token) throw new UnauthorizedError('OAuth bearer token required');
        if (config.authorizationServers.length > 0) {
          try { return await runtime.oauth.verify(token); }
          catch (externalError) {
            if (!config.allowStaticMcpTokens) throw new UnauthorizedError('Invalid or expired OAuth bearer token');
          }
        }
        if (config.allowStaticMcpTokens) {
          try { return runtime.tokenService.verify(token, { expectedType: 'user' }); }
          catch { /* handled below */ }
        }
        throw new UnauthorizedError('Invalid or expired OAuth bearer token');
      };
      const deviceUser = async () => {
        const token = bearerFromHeaders(req.headers);
        if (!token) throw new UnauthorizedError('Device bearer token required');
        let principal;
        try { principal = runtime.tokenService.verify(token, { expectedType: 'device' }); }
        catch { throw new UnauthorizedError('Invalid or expired device bearer token'); }
        await runtime.broker.assertDevicePrincipal(principal);
        return principal;
      };

      if (pathname === '/v1/pairings/approve' && req.method === 'POST') {
        const principal = await internalUser();
        const body = await readJson(req, 16 * 1024);
        const result = await runtime.broker.approvePairing(principal, body.user_code);
        statusForLog = 200;
        return sendJson(res, 200, result, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/devices' && req.method === 'GET') {
        const principal = await internalUser();
        const devices = await runtime.broker.listDevices(principal);
        statusForLog = 200;
        return sendJson(res, 200, { devices }, { 'cache-control': 'no-store' });
      }
      const revokeMatch = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(pathname);
      if (revokeMatch && req.method === 'POST') {
        const principal = await internalUser();
        const device = await runtime.broker.revokeDevice(principal, decodeURIComponent(revokeMatch[1]));
        statusForLog = 200;
        return sendJson(res, 200, { device }, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/calls' && req.method === 'GET') {
        const principal = await internalUser();
        const limitValue = Number.parseInt(url.searchParams.get('limit') || '50', 10);
        const calls = await runtime.broker.listCalls(principal, { limit: Number.isFinite(limitValue) ? limitValue : 50 });
        statusForLog = 200;
        return sendJson(res, 200, { calls }, { 'cache-control': 'no-store' });
      }
      const getCallMatch = /^\/v1\/calls\/([^/]+)$/.exec(pathname);
      if (getCallMatch && req.method === 'GET') {
        const principal = await internalUser();
        const call = await runtime.broker.getCall(principal, decodeURIComponent(getCallMatch[1]), { includeResult: true });
        statusForLog = 200;
        return sendJson(res, 200, { call }, { 'cache-control': 'no-store' });
      }
      const approveCallMatch = /^\/v1\/calls\/([^/]+)\/approve$/.exec(pathname);
      if (approveCallMatch && req.method === 'POST') {
        const principal = await internalUser();
        const call = await runtime.broker.approveCall(principal, decodeURIComponent(approveCallMatch[1]));
        statusForLog = 200;
        return sendJson(res, 200, { call }, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/audit/verify' && req.method === 'GET') {
        const principal = await internalUser();
        const auditStatus = await runtime.broker.verifyAudit(principal);
        statusForLog = 200;
        return sendJson(res, 200, { audit: auditStatus }, { 'cache-control': 'no-store' });
      }

      if (pathname === '/v1/device/token/refresh' && req.method === 'POST') {
        const principal = await deviceUser();
        await readJson(req, 4096);
        const refreshed = await runtime.broker.refreshDeviceToken(principal);
        statusForLog = 200;
        return sendJson(res, 200, refreshed, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/device/register' && req.method === 'POST') {
        const principal = await deviceUser();
        const body = await readJson(req, config.maxBodyBytes);
        const device = await runtime.broker.registerDevice(principal, body);
        statusForLog = 200;
        return sendJson(res, 200, device, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/device/heartbeat' && req.method === 'POST') {
        const principal = await deviceUser();
        const body = await readJson(req, 32 * 1024);
        const device = await runtime.broker.heartbeat(principal, body);
        statusForLog = 200;
        return sendJson(res, 200, device, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/device/calls' && req.method === 'GET') {
        const principal = await deviceUser();
        const calls = await runtime.broker.listQueuedForDevice(principal);
        statusForLog = 200;
        return sendJson(res, 200, { calls }, { 'cache-control': 'no-store' });
      }
      const claimMatch = /^\/v1\/device\/calls\/([^/]+)\/claim$/.exec(pathname);
      if (claimMatch && req.method === 'POST') {
        const principal = await deviceUser();
        await readJson(req, 4096);
        const claim = await runtime.broker.claimCall(principal, decodeURIComponent(claimMatch[1]));
        statusForLog = 200;
        return sendJson(res, 200, claim, { 'cache-control': 'no-store' });
      }
      const completeMatch = /^\/v1\/device\/calls\/([^/]+)\/complete$/.exec(pathname);
      if (completeMatch && req.method === 'POST') {
        const principal = await deviceUser();
        const body = await readJson(req, config.maxBodyBytes);
        const call = await runtime.broker.completeCall(principal, decodeURIComponent(completeMatch[1]), body.result);
        statusForLog = 200;
        return sendJson(res, 200, { call }, { 'cache-control': 'no-store' });
      }
      const failMatch = /^\/v1\/device\/calls\/([^/]+)\/fail$/.exec(pathname);
      if (failMatch && req.method === 'POST') {
        const principal = await deviceUser();
        const body = await readJson(req, 32 * 1024);
        const call = await runtime.broker.failCall(principal, decodeURIComponent(failMatch[1]), body.error);
        statusForLog = 200;
        return sendJson(res, 200, { call }, { 'cache-control': 'no-store' });
      }
      if (pathname === '/v1/device/events' && req.method === 'GET') {
        const principal = await deviceUser();
        const device = await runtime.broker.assertDevicePrincipal(principal);
        statusForLog = 200;
        res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', deviceId: device.id })}\n\n`);
        const clients = deviceStreams.get(device.id) ?? new Set();
        clients.add(res);
        deviceStreams.set(device.id, clients);
        const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 15_000);
        keepAlive.unref?.();
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
          if (clients.size === 0) deviceStreams.delete(device.id);
        });
        return;
      }

      if (pathname === '/mcp') {
        if (req.method !== 'POST') {
          statusForLog = 405;
          res.setHeader('allow', 'POST');
          return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint accepts POST only' } });
        }
        let principal;
        try { principal = await mcpUser(); }
        catch (error) {
          statusForLog = 401;
          return sendJson(res, 401, errorBody(error), { 'www-authenticate': bearerChallenge(config), 'cache-control': 'no-store' });
        }
        const body = await readJson(req, config.maxBodyBytes);
        const modern = isModernMcpRequest(body);
        if (modern) {
          try {
            validateAcceptForModern(req);
            let schema = null;
            if (body.method === 'tools/call' && typeof body?.params?.name === 'string' && !body.params.name.startsWith('nymrel_remote_')) {
              const resolved = await runtime.broker.resolveProjectedTool(principal, body.params.name);
              schema = resolved.tool.inputSchema;
            }
            validateModernMcpHeaders(req.headers, body, schema);
          } catch (error) {
            if (error instanceof HeaderMismatchError) {
              statusForLog = 400;
              return sendJson(res, 400, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32020, message: error.message } }, { 'cache-control': 'no-store' });
            }
            throw error;
          }
        }
        const response = await runtime.mcp.handle(body, principal);
        if (body.id === undefined || response === null) {
          statusForLog = 202;
          res.writeHead(202, { 'cache-control': 'no-store' });
          return res.end();
        }
        if (modern && response?.error?.code === -32022) statusForLog = 400;
        else if (modern && response?.error?.code === -32601) statusForLog = 404;
        else if (response?.error?.data?.code === 'POLICY_DENIED' || response?.error?.data?.code === 'FORBIDDEN') {
          statusForLog = 403;
          const capability = response?.error?.data?.details?.capability;
          const explicitScope = extractRequiredScope(response?.error?.message);
          const scope = explicitScope || (capability ? `tools:${capability}` : BASIC_MCP_SCOPES.join(' '));
          return sendJson(res, 403, response, {
            'www-authenticate': bearerChallenge(config, { scope, insufficient: true }), 'cache-control': 'no-store'
          });
        } else statusForLog = 200;
        return sendJson(res, statusForLog, response, { 'cache-control': 'no-store' });
      }

      statusForLog = 404;
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (error) {
      const status = error?.status || (error instanceof NymrelRemoteError ? error.status : 500);
      statusForLog = status;
      if (status >= 500) runtime.logger.error?.(`Request failed ${requestId}: ${error?.name || 'Error'} (${error?.code || 'no-code'})`);
      const headers = { 'cache-control': 'no-store' };
      if (status === 401) headers['www-authenticate'] = bearerChallenge(config);
      const missingScope = status === 403 ? extractRequiredScope(error.message) : null;
      if (missingScope) headers['www-authenticate'] = bearerChallenge(config, { scope: missingScope, insufficient: true });
      return sendJson(res, status, errorBody(error), headers);
    }
  });

  server.on('clientError', (_error, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* no-op */ }
  });

  const cleanup = setInterval(() => runtime.broker.cleanup().catch((error) => runtime.logger.error?.(`Cleanup failed: ${error.name}`)), 15_000);
  cleanup.unref?.();

  if (runtime.instanceLease) {
    runtime.instanceLease.onLost = () => {
      try { server.close(); } catch { /* already closing */ }
    };
  }

  server.on('close', () => {
    clearInterval(cleanup);
    runtime.broker.off('call', sendDoorbell);
    for (const clients of deviceStreams.values()) for (const res of clients) try { res.end(); } catch { /* no-op */ }
    deviceStreams.clear();
    void runtime.instanceLease?.release();
  });

  return { server, runtime };
}

export async function listenRemoteServer(config, options = {}) {
  const { server, runtime } = await createRemoteHttpServer(config, options);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return { server, runtime };
  } catch (error) {
    await runtime.instanceLease?.release();
    throw error;
  }
}
