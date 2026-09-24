import { pathToFileURL } from 'node:url';

const PUBLIC_RESOURCE = 'https://mcp.nymrel.com/mcp';
const BACKEND_RESOURCE = 'https://nymrel-remote-production.up.railway.app/nymrel/plugin/readonly/mcp';
const PUBLIC_METADATA = 'https://mcp.nymrel.com/.well-known/oauth-protected-resource/mcp';
const BACKEND_METADATA = 'https://nymrel-remote-production.up.railway.app/.well-known/oauth-protected-resource/nymrel/plugin/readonly/mcp';
const READ_SCOPES = ['devices:read', 'tools:read'];

async function probe(fetchImpl, url, init) {
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'manual' });
    let body = null;
    try { body = await response.json(); } catch { /* A non-JSON error is still a valid status observation. */ }
    return { status: response.status, body, challenge: response.headers.get('www-authenticate') || '' };
  } catch (error) {
    return { status: 0, body: null, challenge: '', error: error?.message || 'request failed' };
  }
}

function exactScopes(value) {
  return Array.isArray(value) && value.length === READ_SCOPES.length &&
    READ_SCOPES.every((scope) => value.includes(scope));
}

function challengeParameters(value) {
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  if (!bearer) return null;
  const parameters = new Map();
  for (const part of bearer[1].split(',')) {
    const match = /^\s*([a-z_]+)="([^"]*)"\s*$/i.exec(part);
    if (!match || parameters.has(match[1].toLowerCase())) return null;
    parameters.set(match[1].toLowerCase(), match[2]);
  }
  return parameters;
}

function validIssuer(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') ||
      value !== value.trim() || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash && value === url.href;
  } catch { return false; }
}

function check(name, passed, detail) { return { name, passed: Boolean(passed), detail }; }

/** A public, read-only preflight. It never presents credentials or claims a ChatGPT login passed. */
export async function checkNymrelPluginBridge({ fetchImpl = fetch } = {}) {
  const checks = [];
  const publicMetadata = await probe(fetchImpl, PUBLIC_METADATA);
  const publicIssuers = publicMetadata.body?.authorization_servers;
  checks.push(check('public_resource_metadata',
    publicMetadata.status === 200 && publicMetadata.body?.resource === PUBLIC_RESOURCE &&
    exactScopes(publicMetadata.body?.scopes_supported) &&
    Array.isArray(publicIssuers) && publicIssuers.length === 1 &&
    validIssuer(publicIssuers[0]),
    { status: publicMetadata.status, resource: publicMetadata.body?.resource ?? null,
      readScopesOnly: exactScopes(publicMetadata.body?.scopes_supported),
      issuerCount: Array.isArray(publicIssuers) ? publicIssuers.length : 0 }));

  const backendMetadata = await probe(fetchImpl, BACKEND_METADATA);
  const backendIssuers = backendMetadata.body?.authorization_servers;
  checks.push(check('backend_resource_metadata',
    backendMetadata.status === 200 && backendMetadata.body?.resource === PUBLIC_RESOURCE &&
    exactScopes(backendMetadata.body?.scopes_supported) &&
    Array.isArray(backendIssuers) && backendIssuers.length === 1 &&
    backendIssuers[0] === publicIssuers?.[0],
    { status: backendMetadata.status, resource: backendMetadata.body?.resource ?? null,
      readScopesOnly: exactScopes(backendMetadata.body?.scopes_supported),
      sameIssuer: Array.isArray(backendIssuers) && backendIssuers.length === 1 && backendIssuers[0] === publicIssuers?.[0] }));

  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28'
  };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'nymrel-bridge-preflight', version: '1' } } });
  const anonymous = await probe(fetchImpl, BACKEND_RESOURCE, { method: 'POST', headers, body });
  const parameters = challengeParameters(anonymous.challenge);
  const scopes = parameters?.get('scope')?.split(/\s+/).filter(Boolean) ?? [];
  checks.push(check('backend_anonymous_challenge',
    anonymous.status === 401 && parameters !== null &&
    parameters.get('resource_metadata') === PUBLIC_METADATA && exactScopes(scopes),
    { status: anonymous.status, bearerChallenge: parameters !== null,
      publicMetadataReferenced: parameters?.get('resource_metadata') === PUBLIC_METADATA,
      readScopesOnly: exactScopes(scopes) }));

  const invalid = await probe(fetchImpl, BACKEND_RESOURCE, { method: 'POST',
    headers: { ...headers, authorization: 'Bearer nymrel-bridge-preflight-invalid' }, body });
  checks.push(check('backend_rejects_invalid_bearer', invalid.status === 401, { status: invalid.status }));

  const failures = checks.filter((item) => !item.passed).map((item) => item.name);
  return {
    status: failures.length ? (backendMetadata.status === 404 && anonymous.status === 404 ? 'backend_disabled' : 'blocked') : 'ready_for_login_test',
    checks, failures,
    authenticatedChatgptRead: 'not_validated'
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await checkNymrelPluginBridge();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ready_for_login_test') process.exitCode = 1;
}
