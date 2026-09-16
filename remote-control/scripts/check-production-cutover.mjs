import { fileURLToPath } from 'node:url';

export const REQUIRED_CHATGPT_SCOPES = Object.freeze([
  'devices:read',
  'tools:read',
  'tools:write',
  'tools:execute',
  'tools:network'
]);

function normalizedBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('Production cutover URL must use https');
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
}

async function probe(fetchImpl, url, init = {}) {
  try {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
    return { ok: response.ok, status: response.status, headers: response.headers, text, json };
  } catch (error) {
    return { ok: false, status: 0, headers: new Headers(), text: '', json: null, error: error.message };
  }
}

function check(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

export async function checkProductionCutover(baseUrl, { fetchImpl = fetch, requireOAuth = true } = {}) {
  const base = normalizedBaseUrl(baseUrl);
  const checks = [];

  const health = await probe(fetchImpl, `${base}/healthz`);
  checks.push(check('healthz', health.status === 200 && health.json?.status === 'ok', {
    status: health.status, body: health.json ?? health.error ?? null
  }));

  const ready = await probe(fetchImpl, `${base}/readyz`);
  checks.push(check('readyz', ready.status === 200 && ready.json?.status === 'ready' && ready.json?.audit?.valid === true, {
    status: ready.status,
    readyStatus: ready.json?.status ?? null,
    auditValid: ready.json?.audit?.valid ?? null
  }));

  const metadataPath = '/.well-known/oauth-protected-resource/chatgpt/mcp';
  const metadata = await probe(fetchImpl, `${base}${metadataPath}`);
  const authorizationServers = Array.isArray(metadata.json?.authorization_servers)
    ? metadata.json.authorization_servers.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const scopes = Array.isArray(metadata.json?.scopes_supported) ? metadata.json.scopes_supported : [];
  const missingScopes = REQUIRED_CHATGPT_SCOPES.filter((scope) => !scopes.includes(scope));
  const expectedResource = `${base}/chatgpt/mcp`;
  const metadataPassed = metadata.status === 200
    && metadata.json?.resource === expectedResource
    && missingScopes.length === 0
    && (!requireOAuth || authorizationServers.length > 0);
  checks.push(check('chatgpt protected-resource metadata', metadataPassed, {
    status: metadata.status,
    resource: metadata.json?.resource ?? null,
    expectedResource,
    authorizationServerCount: authorizationServers.length,
    requireOAuth,
    missingScopes
  }));

  for (const path of ['/privacy', '/terms', '/support']) {
    const page = await probe(fetchImpl, `${base}${path}`);
    checks.push(check(`public page ${path}`, page.status === 200 && /text\/html/i.test(page.headers.get('content-type') || ''), {
      status: page.status,
      contentType: page.headers.get('content-type') || null
    }));
  }

  const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'nymrel-cutover-probe', version: '1' } }
  };
  const unauthenticated = await probe(fetchImpl, `${base}/chatgpt/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28'
    },
    body: JSON.stringify(initializeBody)
  });
  const challenge = unauthenticated.headers.get('www-authenticate') || '';
  const challengePassed = unauthenticated.status === 401
    && /^Bearer\b/i.test(challenge)
    && challenge.includes(`${base}${metadataPath}`);
  checks.push(check('unauthenticated ChatGPT MCP challenge', challengePassed, {
    status: unauthenticated.status,
    hasBearerChallenge: /^Bearer\b/i.test(challenge),
    referencesMetadata: challenge.includes(`${base}${metadataPath}`)
  }));

  const failed = checks.filter((item) => !item.passed);
  return {
    status: failed.length === 0 ? 'ready' : 'blocked',
    baseUrl: base,
    requireOAuth,
    checks,
    failures: failed.map((item) => item.name)
  };
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`));
}

if (isMain()) {
  const args = process.argv.slice(2);
  const allowStaticAuth = args.includes('--allow-static-auth');
  const urlArg = args.find((arg) => !arg.startsWith('--')) || process.env.NYMREL_REMOTE_PUBLIC_URL;
  if (!urlArg) {
    console.error('Usage: node scripts/check-production-cutover.mjs <https://remote.example.com> [--allow-static-auth]');
    process.exitCode = 2;
  } else {
    try {
      const result = await checkProductionCutover(urlArg, { requireOAuth: !allowStaticAuth });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'ready') process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ status: 'error', error: error.message }, null, 2));
      process.exitCode = 2;
    }
  }
}
