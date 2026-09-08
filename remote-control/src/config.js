import path from 'node:path';
import os from 'node:os';
import { parseKey } from './crypto.js';
import { defaultStorePath } from './store.js';

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}


function listEnv(name) {
  return String(process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function devKey(label) {
  return Buffer.from(label.padEnd(32, '_').slice(0, 32), 'utf8');
}

export function loadServerConfig() {
  const production = process.env.NODE_ENV === 'production';
  const signingKey = process.env.NYMREL_REMOTE_SIGNING_KEY
    ? parseKey(process.env.NYMREL_REMOTE_SIGNING_KEY, 'NYMREL_REMOTE_SIGNING_KEY')
    : (production ? null : devKey('nymrel-remote-dev-signing-key'));
  const dataKey = process.env.NYMREL_REMOTE_DATA_KEY
    ? parseKey(process.env.NYMREL_REMOTE_DATA_KEY, 'NYMREL_REMOTE_DATA_KEY')
    : (production ? null : devKey('nymrel-remote-dev-data-key'));
  const auditKey = process.env.NYMREL_REMOTE_AUDIT_KEY
    ? parseKey(process.env.NYMREL_REMOTE_AUDIT_KEY, 'NYMREL_REMOTE_AUDIT_KEY')
    : (production ? null : devKey('nymrel-remote-dev-audit-key'));
  if (!signingKey || !dataKey || !auditKey) {
    throw new Error('Production requires NYMREL_REMOTE_SIGNING_KEY, NYMREL_REMOTE_DATA_KEY, and NYMREL_REMOTE_AUDIT_KEY');
  }
  if (production && (signingKey.equals(dataKey) || signingKey.equals(auditKey) || dataKey.equals(auditKey))) {
    throw new Error('Production signing, data, and audit keys must be independent values');
  }
  const bootstrapToken = process.env.NYMREL_REMOTE_BOOTSTRAP_TOKEN;
  if (production && (!bootstrapToken || bootstrapToken.length < 32)) {
    throw new Error('Production requires NYMREL_REMOTE_BOOTSTRAP_TOKEN with at least 32 characters');
  }
  const publicBaseUrl = process.env.NYMREL_REMOTE_PUBLIC_URL?.replace(/\/$/, '') || null;
  if (publicBaseUrl) {
    let parsedPublic;
    try { parsedPublic = new URL(publicBaseUrl); } catch { throw new Error('NYMREL_REMOTE_PUBLIC_URL must be a valid absolute URL'); }
    if (production && parsedPublic.protocol !== 'https:') throw new Error('Production NYMREL_REMOTE_PUBLIC_URL must use https');
  }
  const authorizationServers = listEnv('NYMREL_REMOTE_AUTHORIZATION_SERVERS').map((value) => value.replace(/\/$/, ''));
  for (const server of authorizationServers) {
    let parsed;
    try { parsed = new URL(server); } catch { throw new Error('NYMREL_REMOTE_AUTHORIZATION_SERVERS contains an invalid URL'); }
    if (production && parsed.protocol !== 'https:') throw new Error('Production authorization server URLs must use https');
  }
  const allowStaticMcpTokens = boolEnv('NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS', !production);
  const allowStaticAdminTokens = boolEnv('NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS', !production);
  const allowBootstrapHttp = boolEnv('NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP', !production);
  if (production && !publicBaseUrl) throw new Error('Production requires NYMREL_REMOTE_PUBLIC_URL');
  if (production && authorizationServers.length === 0 && !allowStaticMcpTokens) {
    throw new Error('Production MCP authorization requires NYMREL_REMOTE_AUTHORIZATION_SERVERS or explicit NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS=true');
  }
  if (production && authorizationServers.length === 0 && !allowStaticAdminTokens) {
    throw new Error('Production operator authorization requires NYMREL_REMOTE_AUTHORIZATION_SERVERS or explicit NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS=true');
  }
  return {
    production,
    host: process.env.NYMREL_REMOTE_HOST || '127.0.0.1',
    port: intEnv('NYMREL_REMOTE_PORT', 8787, { min: 1, max: 65535 }),
    publicBaseUrl,
    storePath: path.resolve(process.env.NYMREL_REMOTE_STORE || defaultStorePath()),
    signingKey,
    dataKey,
    auditKey,
    bootstrapToken: bootstrapToken || 'development-bootstrap-token-change-me',
    callTtlMs: intEnv('NYMREL_REMOTE_CALL_TTL_MS', 5 * 60 * 1000, { min: 5000 }),
    syncWaitMs: intEnv('NYMREL_REMOTE_SYNC_WAIT_MS', 25000, { min: 0, max: 120000 }),
    heartbeatTtlMs: intEnv('NYMREL_REMOTE_HEARTBEAT_TTL_MS', 45000, { min: 10000 }),
    instanceLeaseTtlMs: intEnv('NYMREL_REMOTE_INSTANCE_LEASE_TTL_MS', 30000, { min: 5000 }),
    pairingTtlMs: intEnv('NYMREL_REMOTE_PAIRING_TTL_MS', 10 * 60 * 1000, { min: 60000 }),
    maxBodyBytes: intEnv('NYMREL_REMOTE_MAX_BODY_BYTES', 4 * 1024 * 1024, { min: 1024 }),
    maxToolSchemaBytes: intEnv('NYMREL_REMOTE_MAX_TOOL_SCHEMA_BYTES', 128 * 1024, { min: 1024 }),
    maxToolsPerDevice: intEnv('NYMREL_REMOTE_MAX_TOOLS_PER_DEVICE', 128, { min: 1, max: 1024 }),
    allowInsecureRemoteAgent: boolEnv('NYMREL_REMOTE_ALLOW_INSECURE_AGENT', false),
    allowedOrigins: listEnv('NYMREL_REMOTE_ALLOWED_ORIGINS'),
    authorizationServers,
    allowStaticMcpTokens,
    allowStaticAdminTokens,
    allowBootstrapHttp,
    oauthIssuer: process.env.NYMREL_REMOTE_OAUTH_ISSUER?.replace(/\/$/, '') || authorizationServers[0] || null,
    oauthJwksUrl: process.env.NYMREL_REMOTE_OAUTH_JWKS_URL || null,
    oauthAudience: process.env.NYMREL_REMOTE_OAUTH_AUDIENCE || (publicBaseUrl ? `${publicBaseUrl}/mcp` : null),
    oauthTenantClaim: process.env.NYMREL_REMOTE_OAUTH_TENANT_CLAIM || 'tenant',
    oauthIntrospectionUrl: process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_URL || null,
    oauthIntrospectionClientId: process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_ID || null,
    oauthIntrospectionClientSecret: process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_SECRET || null
  };
}

export function normalizeAgentServerUrl(value) {
  const parsed = new URL(value);
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('NYMREL_REMOTE_SERVER_URL must be an origin without credentials, query, fragment, or path');
  }
  if (parsed.protocol !== 'https:' && !isLocal && !boolEnv('NYMREL_REMOTE_ALLOW_INSECURE_AGENT', false)) {
    throw new Error('Remote agent requires HTTPS unless connecting to localhost');
  }
  return parsed.origin;
}

export function loadAgentConfig(argv = process.argv.slice(2)) {
  const serverUrl = normalizeAgentServerUrl(process.env.NYMREL_REMOTE_SERVER_URL || 'http://127.0.0.1:8787');
  let mcpArgs = [];
  if (process.env.NYMREL_REMOTE_MCP_ARGS) {
    mcpArgs = JSON.parse(process.env.NYMREL_REMOTE_MCP_ARGS);
    if (!Array.isArray(mcpArgs) || mcpArgs.some((x) => typeof x !== 'string')) throw new Error('NYMREL_REMOTE_MCP_ARGS must be a JSON string array');
  }
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    deviceName: process.env.NYMREL_REMOTE_DEVICE_NAME || os.hostname(),
    platform: process.platform,
    tokenFile: path.resolve(process.env.NYMREL_REMOTE_DEVICE_FILE || path.join(os.homedir(), '.nymrel-remote', 'device.json')),
    mcpCommand: process.env.NYMREL_REMOTE_MCP_COMMAND || 'desktop-commander',
    mcpArgs,
    mcpCwd: process.env.NYMREL_REMOTE_MCP_CWD || undefined,
    deviceCode: process.env.NYMREL_REMOTE_DEVICE_CODE || argv.find((arg) => arg.startsWith('--device-code='))?.split('=')[1] || null,
    heartbeatMs: intEnv('NYMREL_REMOTE_AGENT_HEARTBEAT_MS', 15000, { min: 5000 }),
    callTimeoutMs: intEnv('NYMREL_REMOTE_AGENT_CALL_TIMEOUT_MS', 4 * 60 * 1000, { min: 1000 })
  };
}
