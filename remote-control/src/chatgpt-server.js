import { OAuthAccessTokenVerifier } from './oauth.js';
import { ChatgptMcpEdge } from './chatgpt-mcp-edge.js';
import { HeaderMismatchError, isModernMcpRequest, validateModernMcpHeaders } from './mcp-http-validation.js';
import { NymrelRemoteError, UnauthorizedError } from './errors.js';
import { bearerFromHeaders } from './token.js';
import { createRemoteHttpServer } from './server.js';

const CHATGPT_MCP_SCOPES = [
  'devices:read', 'tools:read', 'tools:write', 'tools:execute', 'tools:network'
];

function publicOrigin(config) {
  return config.publicBaseUrl || `http://${config.host}:${config.port}`;
}

function chatgptResource(config) {
  return `${publicOrigin(config)}/chatgpt/mcp`;
}

function metadataUrl(config) {
  return `${publicOrigin(config)}/.well-known/oauth-protected-resource/chatgpt/mcp`;
}

function challenge(config, { scope = CHATGPT_MCP_SCOPES.join(' '), insufficient = false } = {}) {
  const parts = [];
  if (insufficient) parts.push('error="insufficient_scope"');
  if (scope) parts.push(`scope="${scope}"`);
  parts.push(`resource_metadata="${metadataUrl(config)}"`);
  return `Bearer ${parts.join(', ')}`;
}

function sendJson(res, status, value, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Malformed JSON body'); error.status = 400; throw error; }
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set(config.allowedOrigins);
  if (config.publicBaseUrl) allowed.add(new URL(config.publicBaseUrl).origin);
  if (!config.production) {
    allowed.add(`http://127.0.0.1:${config.port}`);
    allowed.add(`http://localhost:${config.port}`);
  }
  return allowed.has(origin);
}

function validateAccept(req) {
  const accept = String(req.headers.accept || '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    throw new HeaderMismatchError('Modern MCP requests must Accept both application/json and text/event-stream');
  }
}

function extractRequiredScope(message) {
  const match = /^([^ ]+) scope required$/.exec(String(message || ''));
  return match?.[1] || null;
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
      for (const [item, value] of this.entries) if (value.resetAt <= now) this.entries.delete(item);
    }
    return { allowed: entry.count <= limit, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
}

export async function createChatgptRemoteHttpServer(config, options = {}) {
  const { server, runtime } = await createRemoteHttpServer(config, options);
  const original = server.listeners('request')[0];
  if (!original) throw new Error('Nymrel Remote HTTP request handler is unavailable');

  const edge = new ChatgptMcpEdge({ broker: runtime.broker, syncWaitMs: config.syncWaitMs });
  const oauth = new OAuthAccessTokenVerifier({
    issuer: config.oauthIssuer,
    jwksUrl: config.oauthJwksUrl,
    audience: process.env.NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE || chatgptResource(config),
    tenantClaim: config.oauthTenantClaim,
    introspectionUrl: config.oauthIntrospectionUrl,
    introspectionClientId: config.oauthIntrospectionClientId,
    introspectionClientSecret: config.oauthIntrospectionClientSecret
  });
  const limiter = new FixedWindowRateLimiter();
  runtime.chatgptMcp = edge;
  runtime.chatgptOauth = oauth;

  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;

    if (pathname === '/.well-known/oauth-protected-resource/chatgpt/mcp' && req.method === 'GET') {
      return sendJson(res, 200, {
        resource: chatgptResource(config),
        authorization_servers: config.authorizationServers,
        scopes_supported: CHATGPT_MCP_SCOPES,
        bearer_methods_supported: ['header']
      }, { 'cache-control': 'public, max-age=300' });
    }

    if (pathname !== '/chatgpt/mcp') return original(req, res);

    const started = Date.now();
    let status = 500;
    const finishLog = () => runtime.logger.info?.(`${req.method} /chatgpt/mcp ${status} ${Date.now() - started}ms`);
    res.once('finish', finishLog);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');

    try {
      if (!originAllowed(req, config)) {
        status = 403;
        return sendJson(res, 403, { error: { code: 'ORIGIN_DENIED', message: 'Origin is not allowed' } });
      }
      const ip = req.socket.remoteAddress || 'unknown';
      const rate = limiter.take(`${ip}:chatgpt-mcp`, 600);
      if (!rate.allowed) {
        status = 429;
        return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, { 'retry-after': String(rate.retryAfterSec) });
      }
      if (req.method !== 'POST') {
        status = 405;
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint accepts POST only' } }, { allow: 'POST' });
      }

      const token = bearerFromHeaders(req.headers);
      if (!token) {
        status = 401;
        return sendJson(res, 401, errorBody(new UnauthorizedError('OAuth bearer token required')), { 'www-authenticate': challenge(config) });
      }

      let principal = null;
      if (config.authorizationServers.length > 0) {
        try { principal = await oauth.verify(token); }
        catch {
          if (!config.allowStaticMcpTokens) {
            status = 401;
            return sendJson(res, 401, errorBody(new UnauthorizedError('Invalid or expired OAuth bearer token')), { 'www-authenticate': challenge(config) });
          }
        }
      }
      if (!principal && config.allowStaticMcpTokens) {
        try { principal = runtime.tokenService.verify(token, { expectedType: 'user' }); }
        catch { /* handled below */ }
      }
      if (!principal) {
        status = 401;
        return sendJson(res, 401, errorBody(new UnauthorizedError('Invalid or expired OAuth bearer token')), { 'www-authenticate': challenge(config) });
      }

      const body = await readJson(req, config.maxBodyBytes);
      const modern = isModernMcpRequest(body);
      if (modern) {
        try {
          validateAccept(req);
          const schema = body.method === 'tools/call' && typeof body?.params?.name === 'string'
            ? edge.schemaForTool(body.params.name)
            : null;
          validateModernMcpHeaders(req.headers, body, schema);
        } catch (error) {
          if (error instanceof HeaderMismatchError) {
            status = 400;
            return sendJson(res, 400, {
              jsonrpc: '2.0', id: body?.id ?? null,
              error: { code: -32020, message: error.message }
            });
          }
          throw error;
        }
      }

      const response = await edge.handle(body, principal);
      if (body.id === undefined || response === null) {
        status = 202;
        res.writeHead(202, { 'cache-control': 'no-store' });
        return res.end();
      }
      if (modern && response?.error?.code === -32022) status = 400;
      else if (modern && response?.error?.code === -32601) status = 404;
      else if (response?.error?.data?.code === 'POLICY_DENIED' || response?.error?.data?.code === 'FORBIDDEN') {
        status = 403;
        const capability = response?.error?.data?.details?.capability;
        const explicitScope = extractRequiredScope(response?.error?.message);
        const required = explicitScope || (capability ? `tools:${capability}` : CHATGPT_MCP_SCOPES.join(' '));
        return sendJson(res, 403, response, { 'www-authenticate': challenge(config, { scope: required, insufficient: true }) });
      } else status = 200;
      return sendJson(res, status, response);
    } catch (error) {
      status = error?.status || (error instanceof NymrelRemoteError ? error.status : 500);
      if (status >= 500) runtime.logger.error?.(`ChatGPT MCP request failed: ${error?.name || 'Error'} (${error?.code || 'no-code'})`);
      const headers = {};
      if (status === 401) headers['www-authenticate'] = challenge(config);
      const missingScope = status === 403 ? extractRequiredScope(error.message) : null;
      if (missingScope) headers['www-authenticate'] = challenge(config, { scope: missingScope, insufficient: true });
      return sendJson(res, status, errorBody(error), headers);
    }
  });

  return { server, runtime };
}

export async function listenChatgptRemoteServer(config, options = {}) {
  const { server, runtime } = await createChatgptRemoteHttpServer(config, options);
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
