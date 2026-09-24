import { Provider, errors } from 'oidc-provider';
import { createSqliteStore } from './sqlite-adapter.js';

export const RESOURCE = 'https://mcp.nymrel.com/mcp';
export const READ_SCOPES = 'devices:read tools:read';

function exactHttps(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !value.includes('*'); } catch { return false; }
}

// Library only: there is deliberately no runnable production entry point or login UI.
// The integration must supply authenticated, CSRF-protected interaction handlers.
export function createIssuer({ issuer, clientId, callback, identity, jwks, cookieKeys, databasePath, offline = false }) {
  const url = new URL(issuer);
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!exactHttps(issuer) && !(offline && loopback)) || url.search || url.hash) throw new Error('Invalid issuer');
  if (!clientId || typeof clientId !== 'string' || !exactHttps(callback)) throw new Error('Exact client and HTTPS callback required');
  if (!identity || !exactHttps(identity.issuer) || !identity.subject || !identity.accountId) throw new Error('One explicit identity is required');
  if (!jwks?.keys?.length || jwks.keys.some(k => !k.d || !k.kid || k.kty !== 'RSA' || k.alg !== 'RS256')) throw new Error('Persistent private RS256 signing keys required');
  if (!Array.isArray(cookieKeys) || !cookieKeys.length || cookieKeys.some(k => typeof k !== 'string' || k.length < 32)) throw new Error('Persistent cookie keys required');
  const store = createSqliteStore(databasePath);
  let provider;
  try {
    provider = new Provider(issuer, {
      adapter: store.Adapter,
      clients: [{ client_id: clientId, redirect_uris: [callback], token_endpoint_auth_method: 'none',
        response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
        scope: `openid offline_access ${READ_SCOPES}` }],
      jwks,
      cookies: { keys: cookieKeys },
      scopes: ['openid', 'offline_access', ...READ_SCOPES.split(' ')],
      claims: { openid: ['sub'] },
      subjectTypes: ['public'],
      pkce: { methods: ['S256'], required: () => true },
      features: {
        devInteractions: { enabled: false }, registration: { enabled: false },
        clientCredentials: { enabled: false },
        clientIdMetadataDocument: { enabled: false },
        revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === clientId && token.clientId === clientId },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => undefined,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, resource, client) => {
            if (resource !== RESOURCE || client.clientId !== clientId) throw new errors.InvalidTarget();
            return { scope: READ_SCOPES, audience: RESOURCE, accessTokenFormat: 'jwt',
              accessTokenTTL: 300, jwt: { sign: { alg: 'RS256' } } };
          }
        }
      },
      interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
      findAccount: async (_ctx, accountId) => accountId === identity.accountId ? {
        accountId, claims: async () => ({ sub: accountId })
      } : undefined,
      rotateRefreshToken: true,
      ttl: { AuthorizationCode: 60, AccessToken: 300, IdToken: 300, RefreshToken: 86400, Grant: 86400, Session: 86400, Interaction: 300 }
    });
    // Never silently ignore unsupported scopes or permit absent/multiple resources.
    provider.use(async (ctx, next) => {
      if (ctx.path === '/auth') {
        if (ctx.method !== 'GET') { ctx.status = 405; ctx.set('Allow', 'GET'); return; }
        const query = new URLSearchParams(ctx.querystring);
        const resources = query.getAll('resource');
        if (resources.length !== 1 || resources[0] !== RESOURCE) throw new errors.InvalidTarget();
        const scopes = (query.get('scope') || '').split(/\s+/).filter(Boolean);
        if (scopes.some(s => !['openid', 'offline_access', ...READ_SCOPES.split(' ')].includes(s))) throw new errors.InvalidScope();
      }
      await next();
    });
  } catch (error) { store.close(); throw error; }

  return {
    provider, close: store.close,
    // Call only after upstream identity verification AND interaction CSRF checks.
    async completeLogin(req, res, verifiedIdentity) {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== 'login' || verifiedIdentity?.issuer !== identity.issuer || verifiedIdentity?.subject !== identity.subject) throw new Error('Identity denied');
      await provider.interactionFinished(req, res, { login: { accountId: identity.accountId } }, { mergeWithLastSubmission: false });
    },
    // A separate explicit consent action. Never expose this method as an unauthenticated route.
    async approveConsent(req, res) {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name !== 'consent' || details.session?.accountId !== identity.accountId || details.params.client_id !== clientId) throw new Error('Consent denied');
      const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: identity.accountId, clientId });
      if (!grant) throw new Error('Grant missing');
      const missing = details.prompt.details;
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      for (const [resource, scopes] of Object.entries(missing.missingResourceScopes || {})) {
        if (resource !== RESOURCE || scopes.some(s => !READ_SCOPES.split(' ').includes(s))) throw new Error('Scope denied');
        grant.addResourceScope(resource, scopes.join(' '));
      }
      const grantId = await grant.save();
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    }
  };
}
