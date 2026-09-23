import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from '../src/config.js';
import {
  MAX_OAUTH_SUBJECT_TENANTS,
  OAUTH_SUBJECT_TENANTS_ENV,
  OAuthPrincipalDeniedError,
  OAuthPrincipalPolicy,
  createExternalOAuthAuthenticator,
  parseOAuthSubjectTenants
} from '../src/oauth-principal-policy.js';

const ISSUER = 'https://issuer.example.test/';
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function external(overrides = {}) {
  return { typ: 'user', sub: 'auth0|operator', tenant: 'claimed-tenant', scopes: ['tools:read'], iss: ISSUER, external: true, ...overrides };
}

test('subject-to-tenant mapping parses a bounded explicit JSON object and defaults to empty', () => {
  for (const empty of [undefined, null, '', '   ']) assert.equal(parseOAuthSubjectTenants(empty).size, 0);
  const mapping = parseOAuthSubjectTenants('{"auth0|operator":"default","google-oauth2|123":"team-a"}');
  assert.deepEqual([...mapping], [['auth0|operator', 'default'], ['google-oauth2|123', 'team-a']]);
  // Own keys that collide with Object.prototype names stay plain data.
  assert.equal(parseOAuthSubjectTenants('{"__proto__":"default"}').get('__proto__'), 'default');
  assert.equal(new OAuthPrincipalPolicy({ subjectTenants: parseOAuthSubjectTenants('{"a":"t"}') }).subjectTenants.get('constructor'), undefined);
});

test('subject-to-tenant mapping rejects malformed, unbounded, or ambiguous configuration without echoing values', () => {
  const tooMany = JSON.stringify(Object.fromEntries(
    Array.from({ length: MAX_OAUTH_SUBJECT_TENANTS + 1 }, (_, index) => [`subject-${index}`, 'default'])
  ));
  const invalid = [
    'not-json', '[]', '"auth0|operator"', 'null', '42', '["auth0|operator","default"]', tooMany,
    '{"":"default"}', '{" auth0|operator":"default"}', '{"auth0|operator\\n":"default"}', `{"${'s'.repeat(257)}":"default"}`,
    '{"auth0|operator":""}', '{"auth0|operator":" default"}', '{"auth0|operator":42}', '{"auth0|operator":null}',
    '{"auth0|operator":["default"]}', `{"auth0|operator":"${'t'.repeat(129)}"}`
  ];
  for (const raw of invalid) {
    assert.throws(() => parseOAuthSubjectTenants(raw), (error) => {
      assert.match(error.message, new RegExp(OAUTH_SUBJECT_TENANTS_ENV), raw.slice(0, 40));
      assert.doesNotMatch(error.message, /auth0|operator|subject-\d/, 'configured identifiers must not leak into errors');
      return true;
    });
  }
});

test('policy assigns the mapped tenant and never the tenant carried by the token', () => {
  const policy = new OAuthPrincipalPolicy({ issuer: ISSUER, subjectTenants: new Map([['auth0|operator', 'default']]) });
  const principal = policy.authorize(external());
  assert.equal(principal.tenant, 'default');
  assert.equal(principal.sub, 'auth0|operator');
  assert.deepEqual(principal.scopes, ['tools:read']);
});

test('policy fails closed for unmapped, malformed, non-external, or foreign-issuer principals', () => {
  const policy = new OAuthPrincipalPolicy({ issuer: ISSUER, subjectTenants: new Map([['auth0|operator', 'default']]) });
  const denied = [
    null, undefined, {}, external({ sub: 'auth0|self-signup', tenant: 'default' }), external({ sub: '' }), external({ sub: undefined }),
    external({ sub: 42 }), external({ sub: 'AUTH0|OPERATOR' }), external({ sub: 'auth0|operator ' }), external({ external: false }),
    external({ external: undefined }), external({ iss: 'https://issuer.example.test' }), external({ iss: 'https://attacker.example.test/' }),
    external({ iss: undefined })
  ];
  for (const principal of denied) {
    assert.throws(() => policy.authorize(principal), (error) => error instanceof OAuthPrincipalDeniedError && error.status === 403);
  }
  for (const empty of [new OAuthPrincipalPolicy({ issuer: ISSUER }), new OAuthPrincipalPolicy(), new OAuthPrincipalPolicy({ subjectTenants: { 'auth0|operator': 'default' } })]) {
    assert.throws(() => empty.authorize(external()), OAuthPrincipalDeniedError);
  }
});

test('external OAuth authenticators always require an exact audience', () => {
  const config = { oauthIssuer: ISSUER, oauthSubjectTenants: new Map() };
  for (const audience of [undefined, null, '', 42]) {
    assert.throws(() => createExternalOAuthAuthenticator(config, { audience }), /exact resource audience/);
  }
  assert.equal(createExternalOAuthAuthenticator(config, { audience: 'https://remote.example.test/mcp' }).audience, 'https://remote.example.test/mcp');
});

test('HTTP entry points can only obtain external OAuth verification through the policed factory', async () => {
  for (const file of await fs.readdir(SRC_DIR)) {
    if (!file.endsWith('.js') || file === 'oauth.js' || file === 'oauth-principal-policy.js') continue;
    const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8');
    assert.doesNotMatch(source, /OAuthAccessTokenVerifier/, `${file} must use createExternalOAuthAuthenticator`);
  }
});

function withEnv(values, run) {
  const names = [
    'NODE_ENV', 'NYMREL_REMOTE_SIGNING_KEY', 'NYMREL_REMOTE_DATA_KEY', 'NYMREL_REMOTE_AUDIT_KEY', 'NYMREL_REMOTE_BOOTSTRAP_TOKEN',
    'NYMREL_REMOTE_PUBLIC_URL', 'NYMREL_REMOTE_AUTHORIZATION_SERVERS', 'NYMREL_REMOTE_OAUTH_ISSUER', OAUTH_SUBJECT_TENANTS_ENV,
    'NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS', 'NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS', 'NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP',
    'NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED'
  ];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    NYMREL_REMOTE_SIGNING_KEY: '11'.repeat(32), NYMREL_REMOTE_DATA_KEY: '22'.repeat(32), NYMREL_REMOTE_AUDIT_KEY: '33'.repeat(32),
    NYMREL_REMOTE_BOOTSTRAP_TOKEN: 'test-only-bootstrap-value-not-a-real-credential',
    NYMREL_REMOTE_PUBLIC_URL: 'https://remote.example.test',
    ...overrides
  };
}

test('production refuses external OAuth without an explicit subject-to-tenant mapping', () => {
  withEnv(productionEnv({ NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER }), () => {
    assert.throws(() => loadServerConfig(), new RegExp(OAUTH_SUBJECT_TENANTS_ENV));
  });
  withEnv(productionEnv({ NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER, [OAUTH_SUBJECT_TENANTS_ENV]: '{}' }), () => {
    assert.throws(() => loadServerConfig(), new RegExp(OAUTH_SUBJECT_TENANTS_ENV));
  });
  withEnv(productionEnv({ NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER, [OAUTH_SUBJECT_TENANTS_ENV]: '{"auth0|operator":' }), () => {
    assert.throws(() => loadServerConfig(), /must be a JSON object/);
  });
});

test('production refuses an OAuth issuer that is not an exactly advertised authorization server', () => {
  const mapped = { [OAUTH_SUBJECT_TENANTS_ENV]: '{"auth0|operator":"default"}' };
  withEnv(productionEnv({ ...mapped, NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER, NYMREL_REMOTE_OAUTH_ISSUER: 'https://issuer.example.test' }), () => {
    assert.throws(() => loadServerConfig(), /must exactly match/);
  });
  withEnv(productionEnv({ ...mapped, NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER }), () => {
    const config = loadServerConfig();
    assert.equal(config.oauthIssuer, ISSUER);
    assert.deepEqual([...config.oauthSubjectTenants], [['auth0|operator', 'default']]);
    assert.equal(config.allowStaticMcpTokens, false);
  });
});

test('static-only production configuration keeps loading unchanged and maps no external subjects', () => {
  withEnv(productionEnv({ NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS: 'true', NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS: 'true' }), () => {
    const config = loadServerConfig();
    assert.deepEqual(config.authorizationServers, []);
    assert.equal(config.oauthSubjectTenants.size, 0);
  });
  withEnv({ NODE_ENV: 'development', [OAUTH_SUBJECT_TENANTS_ENV]: '[]' }, () => {
    assert.throws(() => loadServerConfig(), /must be a JSON object/);
  });
});

test('Nymrel plugin backend flag fails closed without external OAuth and defaults off', () => {
  withEnv(productionEnv({
    NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS: 'true', NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS: 'true',
    NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED: 'true'
  }), () => assert.throws(() => loadServerConfig(), /requires NYMREL_REMOTE_AUTHORIZATION_SERVERS/));
  withEnv(productionEnv({
    NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER,
    [OAUTH_SUBJECT_TENANTS_ENV]: '{"auth0|operator":"chatgpt-studio"}'
  }), () => assert.equal(loadServerConfig().nymrelPluginReadonlyEnabled, false));
  withEnv(productionEnv({
    NYMREL_REMOTE_AUTHORIZATION_SERVERS: ISSUER,
    [OAUTH_SUBJECT_TENANTS_ENV]: '{"auth0|operator":"chatgpt-studio"}',
    NYMREL_REMOTE_NYMREL_PLUGIN_READONLY_ENABLED: 'true'
  }), () => assert.equal(loadServerConfig().nymrelPluginReadonlyEnabled, true));
});
