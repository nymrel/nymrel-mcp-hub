import { NymrelRemoteError } from './errors.js';
import { OAuthAccessTokenVerifier } from './oauth.js';

export const OAUTH_SUBJECT_TENANTS_ENV = 'NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS';
export const MAX_OAUTH_SUBJECT_TENANTS = 32;
const MAX_SUBJECT_LENGTH = 256;
const MAX_TENANT_LENGTH = 128;

function boundedIdentifier(value, maxLength) {
  // Identifiers are compared exactly, so reject anything that could be confused after trimming.
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

// Parses the operator-provided JSON object of exact OAuth subject -> tenant id.
// Errors never echo configured values so account identifiers stay out of logs.
export function parseOAuthSubjectTenants(raw, name = OAUTH_SUBJECT_TENANTS_ENV) {
  const mapping = new Map();
  if (raw === undefined || raw === null || String(raw).trim() === '') return mapping;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON object of OAuth subject to tenant id`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of OAuth subject to tenant id`);
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_OAUTH_SUBJECT_TENANTS) throw new Error(`${name} supports at most ${MAX_OAUTH_SUBJECT_TENANTS} subjects`);
  for (const [subject, tenant] of entries) {
    if (!boundedIdentifier(subject, MAX_SUBJECT_LENGTH)) throw new Error(`${name} contains an invalid OAuth subject`);
    if (!boundedIdentifier(tenant, MAX_TENANT_LENGTH)) throw new Error(`${name} contains an invalid tenant id`);
    mapping.set(subject, tenant);
  }
  return mapping;
}

export class OAuthPrincipalDeniedError extends NymrelRemoteError {
  constructor() {
    super('OAuth subject is not authorized for this resource', { code: 'OAUTH_SUBJECT_DENIED', status: 403 });
  }
}

// External identity providers may allow self-signup or dynamic client registration, so a valid
// token alone proves nothing about tenancy. The tenant always comes from this explicit mapping;
// tenant claims carried by the token are never trusted to select a tenant.
export class OAuthPrincipalPolicy {
  constructor({ issuer = null, subjectTenants = new Map() } = {}) {
    this.issuer = issuer || null;
    this.subjectTenants = subjectTenants instanceof Map ? subjectTenants : new Map();
  }

  authorize(principal) {
    if (!principal || principal.external !== true) throw new OAuthPrincipalDeniedError();
    if (typeof principal.sub !== 'string' || !principal.sub) throw new OAuthPrincipalDeniedError();
    if (this.issuer && principal.iss !== this.issuer) throw new OAuthPrincipalDeniedError();
    const tenant = this.subjectTenants.get(principal.sub);
    if (!tenant) throw new OAuthPrincipalDeniedError();
    return { ...principal, tenant };
  }
}

export class ExternalOAuthAuthenticator {
  constructor({ verifier, policy }) {
    this.verifier = verifier;
    this.policy = policy;
  }

  get audience() { return this.verifier.audience; }

  async verify(token, now = Date.now()) {
    return this.policy.authorize(await this.verifier.verify(token, now));
  }
}

// The only supported way for an HTTP entry point to accept external OAuth tokens.
export function createExternalOAuthAuthenticator(config, { audience, fetchImpl } = {}) {
  // The verifier treats a missing audience as "any audience", so never build one without it.
  if (typeof audience !== 'string' || !audience) throw new Error('External OAuth requires an exact resource audience');
  const verifier = new OAuthAccessTokenVerifier({
    issuer: config.oauthIssuer,
    jwksUrl: config.oauthJwksUrl,
    audience,
    tenantClaim: config.oauthTenantClaim,
    introspectionUrl: config.oauthIntrospectionUrl,
    introspectionClientId: config.oauthIntrospectionClientId,
    introspectionClientSecret: config.oauthIntrospectionClientSecret,
    ...(fetchImpl ? { fetchImpl } : {})
  });
  const policy = new OAuthPrincipalPolicy({ issuer: config.oauthIssuer, subjectTenants: config.oauthSubjectTenants });
  return new ExternalOAuthAuthenticator({ verifier, policy });
}
