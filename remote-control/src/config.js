import path from 'node:path';
import os from 'node:os';
import { parseKey } from './crypto.js';
import { defaultStorePath } from './store.js';
import { DEFAULT_TOOL_CAPABILITIES } from './policy.js';

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

function jsonObjectEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) return { ...fallback };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  return parsed;
}

function devKey(label) {
  return Buffer.from(label.padEnd(32, '_').slice(0, 32), 'utf8');
}

function validateAbsoluteUrl(value, name, { requireHttps = false } = {}) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid absolute URL`); }
  if (requireHttps && parsed.protocol !== 'https:') throw new Error(`${name} must use https in production`);
  return value.replace(/\/$/, '');
}

function validateTenant(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty tenant identifier of at most 128 characters without control characters`);
  }
  return value;
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
  const stateKey = process.env.NYMREL_REMOTE_STATE_KEY
    ? parseKey(process.env.NYMREL_REMOTE_STATE_KEY, 'NYMREL_REMOTE_STATE_KEY')
    : (production ? null : devKey('nymrel-remote-dev-state-key'));
  if (!signingKey || !dataKey || !auditKey || !stateKey) {
    throw new Error('Production requires NYMREL_REMOTE_SIGNING_KEY, NYMREL_REMOTE_DATA_KEY, NYMREL_REMOTE_AUDIT_KEY, and NYMREL_REMOTE_STATE_KEY');
  }
  if (production) {
    const keys = [signingKey, dataKey, auditKey, stateKey];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (keys[i].equals(keys[j])) throw new Error('Production signing, data, audit, and state keys must be independent values');
      }
    }
  }

  const bootstrapToken = process.env.NYMREL_REMOTE_BOOTSTRAP_TOKEN;
  if (production && (!bootstrapToken || bootstrapToken.length < 32)) {
    throw new Error('Production requires NYMREL_REMOTE_BOOTSTRAP_TOKEN with at least 32 characters');
  }

  const publicBaseUrl = validateAbsoluteUrl(process.env.NYMREL_REMOTE_PUBLIC_URL || null, 'NYMREL_REMOTE_PUBLIC_URL', { requireHttps: production });
  const authorizationServers = listEnv('NYMREL_REMOTE_AUTHORIZATION_SERVERS')
    .map((value) => validateAbsoluteUrl(value, 'NYMREL_REMOTE_AUTHORIZATION_SERVERS', { requireHttps: production }));
  const oauthIssuer = validateAbsoluteUrl(process.env.NYMREL_REMOTE_OAUTH_ISSUER || authorizationServers[0] || null, 'NYMREL_REMOTE_OAUTH_ISSUER', { requireHttps: production });
  const oauthJwksUrl = validateAbsoluteUrl(process.env.NYMREL_REMOTE_OAUTH_JWKS_URL || null, 'NYMREL_REMOTE_OAUTH_JWKS_URL', { requireHttps: production });
  const oauthIntrospectionUrl = validateAbsoluteUrl(process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_URL || null, 'NYMREL_REMOTE_OAUTH_INTROSPECTION_URL', { requireHttps: production });
  const oauthDefaultTenant = validateTenant(process.env.NYMREL_REMOTE_OAUTH_DEFAULT_TENANT || null, 'NYMREL_REMOTE_OAUTH_DEFAULT_TENANT');

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

  const capabilityOverrides = jsonObjectEnv('NYMREL_REMOTE_TOOL_CAPABILITIES_JSON');
  for (const [name, capability] of Object.entries(capabilityOverrides)) {
    if (typeof name !== 'string' || !['read', 'write', 'execute', 'network', 'unknown'].includes(capability)) {
      throw new Error('NYMREL_REMOTE_TOOL_CAPABILITIES_JSON contains an invalid capability mapping');
    }
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
    stateKey,
    bootstrapToken: bootstrapToken || 'development-bootstrap-token-change-me',
    callTtlMs: intEnv('NYMREL_REMOTE_CALL_TTL_MS', 5 * 60 * 1000, { min: 5000 }),
    syncWaitMs: intEnv('NYMREL_REMOTE_SYNC_WAIT_MS', 25000, { min: 0, max: 120000 }),
    heartbeatTtlMs: intEnv('NYMREL_REMOTE_HEARTBEAT_TTL_MS', 45000, { min: 10000 }),
    instanceLeaseTtlMs: intEnv('NYMREL_REMOTE_INSTANCE_LEASE_TTL_MS', 30000, { min: 5000 }),
    pairingTtlMs: intEnv('NYMREL_REMOTE_PAIRING_TTL_MS', 10 * 60 * 1000, { min: 60000 }),
    pairingRetentionMs: intEnv('NYMREL_REMOTE_PAIRING_RETENTION_MS', 24 * 60 * 60 * 1000, { min: 60000 }),
    terminalCallRetentionMs: intEnv('NYMREL_REMOTE_TERMINAL_CALL_RETENTION_MS', 7 * 24 * 60 * 60 * 1000, { min: 60000 }),
    maxPairings: intEnv('NYMREL_REMOTE_MAX_PAIRINGS', 5000, { min: 10 }),
    maxCalls: intEnv('NYMREL_REMOTE_MAX_CALLS', 50000, { min: 100 }),
    maxReceipts: intEnv('NYMREL_REMOTE_MAX_RECEIPTS', 100000, { min: 1000 }),
    maxBodyBytes: intEnv('NYMREL_REMOTE_MAX_BODY_BYTES', 4 * 1024 * 1024, { min: 1024 }),
    maxToolSchemaBytes: intEnv('NYMREL_REMOTE_MAX_TOOL_SCHEMA_BYTES', 128 * 1024, { min: 1024 }),
    maxToolsPerDevice: intEnv('NYMREL_REMOTE_MAX_TOOLS_PER_DEVICE', 128, { min: 1, max: 1024 }),
    allowedOrigins: listEnv('NYMREL_REMOTE_ALLOWED_ORIGINS'),
    trustedProxyIps: listEnv('NYMREL_REMOTE_TRUSTED_PROXY_IPS'),
    authorizationServers,
    allowStaticMcpTokens,
    allowStaticAdminTokens,
    allowBootstrapHttp,
    toolCapabilities: { ...DEFAULT_TOOL_CAPABILITIES, ...capabilityOverrides },
    oauthIssuer,
    oauthJwksUrl,
    oauthAudience: process.env.NYMREL_REMOTE_OAUTH_AUDIENCE || (publicBaseUrl ? `${publicBaseUrl}/mcp` : null),
    oauthTenantClaim: process.env.NYMREL_REMOTE_OAUTH_TENANT_CLAIM || 'tenant',
    oauthDefaultTenant,
    oauthIntrospectionUrl,
    oauthIntrospectionClientId: process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_ID || null,
    oauthIntrospectionClientSecret: process.env.NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_SECRET || null,
    oauthRequireHttps: production,
    oauthFetchTimeoutMs: intEnv('NYMREL_REMOTE_OAUTH_FETCH_TIMEOUT_MS', 5000, { min: 500, max: 30000 }),
    oauthMaxDocumentBytes: intEnv('NYMREL_REMOTE_OAUTH_MAX_DOCUMENT_BYTES', 1024 * 1024, { min: 4096, max: 8 * 1024 * 1024 })
  };
}

export function loadAgentConfig(argv = process.argv.slice(2)) {
  const serverUrl = process.env.NYMREL_REMOTE_SERVER_URL || 'http://127.0.0.1:8787';
  const parsed = new URL(serverUrl);
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocal && !boolEnv('NYMREL_REMOTE_ALLOW_INSECURE_AGENT', false)) {
    throw new Error('Remote agent requires HTTPS unless connecting to localhost');
  }
  let mcpArgs = [];
  if (process.env.NYMREL_REMOTE_MCP_ARGS) {
    mcpArgs = JSON.parse(process.env.NYMREL_REMOTE_MCP_ARGS);
    if (!Array.isArray(mcpArgs) || mcpArgs.some((x) => typeof x !== 'string')) throw new Error('NYMREL_REMOTE_MCP_ARGS must be a JSON string array');
  }
  const mcpEnv = jsonObjectEnv('NYMREL_REMOTE_MCP_ENV_JSON');
  if (Object.values(mcpEnv).some((value) => typeof value !== 'string')) throw new Error('NYMREL_REMOTE_MCP_ENV_JSON values must be strings');
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    serverIsLocal: isLocal,
    deviceName: process.env.NYMREL_REMOTE_DEVICE_NAME || os.hostname(),
    platform: process.platform,
    tokenFile: path.resolve(process.env.NYMREL_REMOTE_DEVICE_FILE || path.join(os.homedir(), '.nymrel-remote', 'device.json')),
    mcpCommand: process.env.NYMREL_REMOTE_MCP_COMMAND || 'desktop-commander',
    mcpArgs,
    mcpCwd: process.env.NYMREL_REMOTE_MCP_CWD || undefined,
    mcpNodeEntry: process.env.NYMREL_REMOTE_MCP_NODE_ENTRY ? path.resolve(process.env.NYMREL_REMOTE_MCP_NODE_ENTRY) : null,
    mcpEnv,
    mcpIsolatedIdentity: boolEnv('NYMREL_REMOTE_MCP_ISOLATED_IDENTITY', isLocal),
    deviceCode: process.env.NYMREL_REMOTE_DEVICE_CODE || argv.find((arg) => arg.startsWith('--device-code='))?.split('=')[1] || null,
    heartbeatMs: intEnv('NYMREL_REMOTE_AGENT_HEARTBEAT_MS', 15000, { min: 5000 }),
    callTimeoutMs: intEnv('NYMREL_REMOTE_AGENT_CALL_TIMEOUT_MS', 4 * 60 * 1000, { min: 1000 })
  };
}