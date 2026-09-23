import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_CHATGPT_SCOPES = Object.freeze([
  'devices:read',
  'tools:read',
  'tools:write',
  'tools:execute',
  'tools:network'
]);

export const REQUIRED_CHATGPT_READONLY_SCOPES = Object.freeze(['devices:read', 'tools:read']);

// The read-only profile is the regular-ChatGPT resource: OAuth only, exactly the two read scopes.
export const CUTOVER_PROFILES = Object.freeze({
  full: Object.freeze({ resourcePath: '/chatgpt/mcp', requiredScopes: REQUIRED_CHATGPT_SCOPES, exactScopes: false, oauthOnly: false }),
  readonly: Object.freeze({ resourcePath: '/chatgpt/readonly/mcp', requiredScopes: REQUIRED_CHATGPT_READONLY_SCOPES, exactScopes: true, oauthOnly: true })
});

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

function authorizationMetadataUrls(issuer) {
  const parsed = new URL(issuer);
  const origin = parsed.origin;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server/${path}`,
    `${origin}/.well-known/openid-configuration/${path}`,
    `${origin}/${path}/.well-known/openid-configuration`
  ];
}

async function probeAuthorizationServer(fetchImpl, issuer) {
  for (const url of authorizationMetadataUrls(issuer)) {
    const response = await probe(fetchImpl, url);
    if (response.status === 200 && response.json) return { ...response, url };
  }
  return { status: 0, json: null, url: null, error: 'authorization server metadata unavailable' };
}

export async function checkProductionCutover(baseUrl, {
  fetchImpl = fetch,
  requireOAuth = true,
  hasPredefinedClient = false,
  verifiedDynamicClient = null,
  profile = 'full'
} = {}) {
  const selected = Object.hasOwn(CUTOVER_PROFILES, profile) ? CUTOVER_PROFILES[profile] : null;
  if (!selected) throw new Error('Unknown cutover profile');
  if (selected.oauthOnly && !requireOAuth) throw new Error('The read-only profile is OAuth-only and cannot allow static auth');
  if (verifiedDynamicClient !== null && !['cimd', 'dcr'].includes(verifiedDynamicClient)) {
    throw new Error('Verified dynamic client must be cimd or dcr');
  }
  if (hasPredefinedClient && verifiedDynamicClient !== null) throw new Error('Select only one client onboarding path');
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

  const metadataPath = `/.well-known/oauth-protected-resource${selected.resourcePath}`;
  const metadata = await probe(fetchImpl, `${base}${metadataPath}`);
  const authorizationServers = Array.isArray(metadata.json?.authorization_servers)
    ? metadata.json.authorization_servers.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const scopes = Array.isArray(metadata.json?.scopes_supported) ? metadata.json.scopes_supported : [];
  const missingScopes = selected.requiredScopes.filter((scope) => !scopes.includes(scope));
  const unexpectedScopes = selected.exactScopes ? scopes.filter((scope) => !selected.requiredScopes.includes(scope)) : [];
  const expectedResource = `${base}${selected.resourcePath}`;
  const metadataPassed = metadata.status === 200
    && metadata.json?.resource === expectedResource
    && missingScopes.length === 0
    && unexpectedScopes.length === 0
    && (!requireOAuth || authorizationServers.length > 0);
  checks.push(check('chatgpt protected-resource metadata', metadataPassed, {
    status: metadata.status,
    resource: metadata.json?.resource ?? null,
    expectedResource,
    authorizationServerCount: authorizationServers.length,
    requireOAuth,
    missingScopes,
    unexpectedScopes
  }));

  if (authorizationServers.length > 0) {
    const authorizationServer = authorizationServers[0];
    const authMetadata = await probeAuthorizationServer(fetchImpl, authorizationServer);
    const authScopes = Array.isArray(authMetadata.json?.scopes_supported) ? authMetadata.json.scopes_supported : [];
    const missingAuthScopes = ['offline_access'].filter((scope) => !authScopes.includes(scope));
    const codeChallengeMethods = Array.isArray(authMetadata.json?.code_challenge_methods_supported)
      ? authMetadata.json.code_challenge_methods_supported
      : [];
    const tokenEndpointAuthMethods = Array.isArray(authMetadata.json?.token_endpoint_auth_methods_supported)
      ? authMetadata.json.token_endpoint_auth_methods_supported
      : [];
    const supportsCimd = authMetadata.json?.client_id_metadata_document_supported === true;
    const supportsDcr = typeof authMetadata.json?.registration_endpoint === 'string';
    // Discovery advertises capabilities, not tenant policy or successful client registration.
    // In strict readonly mode an operator must attest to the selected, completed setup.
    const selectedClient = hasPredefinedClient ? 'predefined' : verifiedDynamicClient;
    const verifiedOnboarding = hasPredefinedClient === true ||
      (verifiedDynamicClient === 'cimd' && supportsCimd) ||
      (verifiedDynamicClient === 'dcr' && supportsDcr);
    const clientOnboardingReady = selected.oauthOnly
      ? verifiedOnboarding
      : supportsCimd || supportsDcr || hasPredefinedClient;
    const authMetadataPassed = authMetadata.status === 200
      && authMetadata.json?.issuer === authorizationServer
      && typeof authMetadata.json?.authorization_endpoint === 'string'
      && typeof authMetadata.json?.token_endpoint === 'string'
      && typeof authMetadata.json?.jwks_uri === 'string'
      && tokenEndpointAuthMethods.length > 0
      && codeChallengeMethods.includes('S256')
      && clientOnboardingReady
      && missingAuthScopes.length === 0;
    checks.push(check('authorization-server metadata', authMetadataPassed, {
      status: authMetadata.status,
      metadataUrl: authMetadata.url,
      issuer: authMetadata.json?.issuer ?? null,
      expectedIssuer: authorizationServer,
      hasAuthorizationEndpoint: typeof authMetadata.json?.authorization_endpoint === 'string',
      hasTokenEndpoint: typeof authMetadata.json?.token_endpoint === 'string',
      hasJwksUri: typeof authMetadata.json?.jwks_uri === 'string',
      supportsPkceS256: codeChallengeMethods.includes('S256'),
      tokenEndpointAuthMethods,
      missingScopes: missingAuthScopes,
      clientOnboarding: {
        ready: clientOnboardingReady,
        selected: selectedClient,
        evidence: verifiedOnboarding ? 'operator-attested' : 'metadata-only',
        cimd: supportsCimd,
        dcr: supportsDcr,
        predefined: hasPredefinedClient
      }
    }));
  }

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
  const mcpHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28'
  };
  const unauthenticated = await probe(fetchImpl, `${base}${selected.resourcePath}`, {
    method: 'POST', headers: mcpHeaders, body: JSON.stringify(initializeBody)
  });
  const challenge = unauthenticated.headers.get('www-authenticate') || '';
  const challengeScopes = (/\bscope="([^"]*)"/.exec(challenge)?.[1] || '').split(/\s+/).filter(Boolean);
  const excessChallengeScopes = selected.exactScopes ? challengeScopes.filter((scope) => !selected.requiredScopes.includes(scope)) : [];
  const challengePassed = unauthenticated.status === 401
    && /^Bearer\b/i.test(challenge)
    && challenge.includes(`${base}${metadataPath}`)
    && excessChallengeScopes.length === 0;
  checks.push(check('unauthenticated ChatGPT MCP challenge', challengePassed, {
    status: unauthenticated.status,
    hasBearerChallenge: /^Bearer\b/i.test(challenge),
    referencesMetadata: challenge.includes(`${base}${metadataPath}`),
    excessChallengeScopes
  }));

  if (selected.oauthOnly) {
    // A fixed, non-secret placeholder: the OAuth-only resource must refuse anything it cannot verify.
    const invalid = await probe(fetchImpl, `${base}${selected.resourcePath}`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer nymrel-cutover-probe-invalid-token' },
      body: JSON.stringify(initializeBody)
    });
    checks.push(check('read-only resource rejects an unverifiable bearer', invalid.status === 401, { status: invalid.status }));
  }

  const failed = checks.filter((item) => !item.passed);
  return {
    status: failed.length === 0 ? 'ready' : 'blocked',
    profile,
    baseUrl: base,
    requireOAuth,
    checks,
    failures: failed.map((item) => item.name)
  };
}

function publicReport(result) {
  return {
    status: result.status,
    profile: result.profile,
    checks: result.checks.map(({ name, passed }) => ({ name, passed })),
    failures: result.failures
  };
}

function isMain() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const allowStaticAuth = args.includes('--allow-static-auth');
  const hasPredefinedClient = args.includes('--predefined-client');
  const verifiedDynamicClient = args.find((arg) => arg.startsWith('--verified-dynamic-client='))?.slice('--verified-dynamic-client='.length) ?? null;
  const onboardingValid = (verifiedDynamicClient === null || ['cimd', 'dcr'].includes(verifiedDynamicClient)) && !(hasPredefinedClient && verifiedDynamicClient !== null);
  const profile = args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) || 'full';
  const profileValid = Object.hasOwn(CUTOVER_PROFILES, profile) && !(CUTOVER_PROFILES[profile].oauthOnly && allowStaticAuth);
  const urlArg = args.find((arg) => !arg.startsWith('--')) || process.env.NYMREL_REMOTE_PUBLIC_URL;
  if (!urlArg || !profileValid || !onboardingValid) {
    console.error('Usage: node scripts/check-production-cutover.mjs <https://remote.example.com> [--profile=full|readonly] [--allow-static-auth] [--predefined-client | --verified-dynamic-client=cimd|dcr]');
    console.error('--profile=readonly is OAuth-only and cannot be combined with --allow-static-auth.');
    process.exitCode = 2;
  } else {
    try {
      const result = await checkProductionCutover(urlArg, {
        requireOAuth: !allowStaticAuth,
        hasPredefinedClient,
        verifiedDynamicClient,
        profile
      });
      console.log(JSON.stringify(publicReport(result), null, 2));
      if (result.status !== 'ready') process.exitCode = 1;
    } catch {
      console.error(JSON.stringify({ status: 'error', error: 'cutover probe failed' }, null, 2));
      process.exitCode = 2;
    }
  }
}
