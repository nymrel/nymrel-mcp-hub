import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto';

function b64urlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function audienceMatches(aud, resource) {
  if (!resource) return true;
  if (typeof aud === 'string') return aud === resource;
  return Array.isArray(aud) && aud.includes(resource);
}

function scopesFromClaims(claims) {
  if (typeof claims.scope === 'string') return claims.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(claims.scp)) return claims.scp.filter((x) => typeof x === 'string');
  if (typeof claims.scp === 'string') return claims.scp.split(/\s+/).filter(Boolean);
  return [];
}

function tenantFromClaims(claims, claimName) {
  const value = claims?.[claimName];
  if (typeof value === 'string' && value) return value.slice(0, 128);
  if (typeof claims.tenant === 'string' && claims.tenant) return claims.tenant.slice(0, 128);
  if (typeof claims.tid === 'string' && claims.tid) return claims.tid.slice(0, 128);
  return 'default';
}

function issuerDiscoveryUrls(issuer) {
  const url = new URL(issuer);
  const base = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) {
    return [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`
    ];
  }
  return [
    `${base}/.well-known/oauth-authorization-server/${path}`,
    `${base}/.well-known/openid-configuration/${path}`,
    `${base}/${path}/.well-known/openid-configuration`
  ];
}

function signatureAlgorithm(alg) {
  if (/^RS(256|384|512)$/.test(alg)) return `RSA-SHA${alg.slice(2)}`;
  if (/^ES(256|384|512)$/.test(alg)) return `SHA${alg.slice(2)}`;
  if (alg === 'EdDSA') return null;
  throw new Error(`Unsupported JWT algorithm: ${alg}`);
}

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derInteger(raw) {
  let value = Buffer.from(raw);
  while (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return Buffer.concat([Buffer.from([0x02]), derLength(value.length), value]);
}

export function joseEcdsaToDer(signature, alg) {
  const coordinateBytes = { ES256: 32, ES384: 48, ES512: 66 }[alg];
  if (!coordinateBytes) throw new Error(`Unsupported ECDSA algorithm: ${alg}`);
  if (signature.length !== coordinateBytes * 2) throw new Error('Invalid JOSE ECDSA signature length');
  const r = derInteger(signature.subarray(0, coordinateBytes));
  const ss = derInteger(signature.subarray(coordinateBytes));
  const body = Buffer.concat([r, ss]);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

export function verifyJwtSignature(token, header, jwk) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT shape');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  let signature = Buffer.from(parts[2], 'base64url');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const alg = signatureAlgorithm(header.alg);
  if (String(header.alg).startsWith('ES')) signature = joseEcdsaToDer(signature, header.alg);
  const ok = cryptoVerify(alg, data, key, signature);
  if (!ok) throw new Error('Invalid OAuth JWT signature');
}

export class OAuthAccessTokenVerifier {
  constructor({
    issuer,
    jwksUrl,
    audience,
    tenantClaim = 'tenant',
    introspectionUrl,
    introspectionClientId,
    introspectionClientSecret,
    clockSkewSec = 30,
    fetchImpl = fetch
  } = {}) {
    this.issuer = issuer?.replace(/\/$/, '') || null;
    this.jwksUrl = jwksUrl || null;
    this.audience = audience || null;
    this.tenantClaim = tenantClaim;
    this.introspectionUrl = introspectionUrl || null;
    this.introspectionClientId = introspectionClientId || null;
    this.introspectionClientSecret = introspectionClientSecret || null;
    this.clockSkewSec = clockSkewSec;
    this.fetch = fetchImpl;
    this.metadataCache = null;
    this.jwksCache = null;
    this.introspectionCache = new Map();
  }

  get enabled() {
    return !!this.issuer || !!this.introspectionUrl;
  }

  async verify(token, now = Date.now()) {
    if (!token || typeof token !== 'string') throw new Error('Missing OAuth access token');
    const jwtLike = token.split('.').length === 3;
    if (jwtLike && this.issuer) return this.#verifyJwt(token, now);
    if (this.introspectionUrl) return this.#introspect(token, now);
    throw new Error('OAuth token cannot be verified by configured verifier');
  }

  async #verifyJwt(token, now) {
    const [encodedHeader, encodedPayload] = token.split('.');
    const header = b64urlJson(encodedHeader);
    const claims = b64urlJson(encodedPayload);
    if (typeof header.alg !== 'string' || header.alg === 'none') throw new Error('Invalid OAuth JWT alg');
    if (claims.iss !== this.issuer) throw new Error('OAuth issuer mismatch');
    const nowSec = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || nowSec > claims.exp + this.clockSkewSec) throw new Error('OAuth token expired');
    if (typeof claims.nbf === 'number' && nowSec + this.clockSkewSec < claims.nbf) throw new Error('OAuth token not active');
    if (!audienceMatches(claims.aud, this.audience)) throw new Error('OAuth token audience mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('OAuth token subject missing');

    const jwks = await this.#getJwks();
    const candidates = jwks.keys.filter((key) => !header.kid || key.kid === header.kid);
    if (candidates.length === 0) {
      // One forced refresh handles normal key rotation without accepting arbitrary keys.
      this.jwksCache = null;
      const refreshed = await this.#getJwks();
      const retry = refreshed.keys.filter((key) => !header.kid || key.kid === header.kid);
      if (retry.length === 0) throw new Error('OAuth JWT signing key not found');
      let last;
      for (const key of retry) {
        try { verifyJwtSignature(token, header, key); last = null; break; } catch (error) { last = error; }
      }
      if (last) throw last;
    } else {
      let verified = false;
      for (const key of candidates) {
        try { verifyJwtSignature(token, header, key); verified = true; break; } catch { /* try next key */ }
      }
      if (!verified) throw new Error('Invalid OAuth JWT signature');
    }

    return {
      typ: 'user',
      sub: claims.sub,
      tenant: tenantFromClaims(claims, this.tenantClaim),
      scopes: scopesFromClaims(claims),
      iss: claims.iss,
      aud: claims.aud,
      exp: claims.exp,
      external: true
    };
  }

  async #getJwks() {
    const now = Date.now();
    if (this.jwksCache && this.jwksCache.expiresAt > now) return this.jwksCache.value;
    let url = this.jwksUrl;
    if (!url) {
      const metadata = await this.#getMetadata();
      url = metadata.jwks_uri;
      if (typeof url !== 'string') throw new Error('Authorization server metadata has no jwks_uri');
    }
    const response = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value?.keys)) throw new Error('Invalid JWKS document');
    this.jwksCache = { value, expiresAt: now + 5 * 60 * 1000 };
    return value;
  }

  async #getMetadata() {
    const now = Date.now();
    if (this.metadataCache && this.metadataCache.expiresAt > now) return this.metadataCache.value;
    let lastError;
    for (const url of issuerDiscoveryUrls(this.issuer)) {
      try {
        const response = await this.fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) continue;
        const value = await response.json();
        if (value?.issuer !== this.issuer) throw new Error('Authorization server metadata issuer mismatch');
        this.metadataCache = { value, expiresAt: now + 10 * 60 * 1000 };
        return value;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Authorization server metadata discovery failed');
  }

  async #introspect(token, now) {
    const key = tokenHash(token);
    const cached = this.introspectionCache.get(key);
    if (cached && cached.expiresAt > now) return cached.principal;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.introspectionClientId) {
      const secret = this.introspectionClientSecret || '';
      headers.authorization = `Basic ${Buffer.from(`${this.introspectionClientId}:${secret}`).toString('base64')}`;
    }
    const body = new URLSearchParams({ token });
    const response = await this.fetch(this.introspectionUrl, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`OAuth introspection failed: HTTP ${response.status}`);
    const claims = await response.json();
    if (claims?.active !== true) throw new Error('OAuth token is inactive');
    if (this.issuer && claims.iss && claims.iss !== this.issuer) throw new Error('OAuth issuer mismatch');
    if (!audienceMatches(claims.aud, this.audience)) throw new Error('OAuth token audience mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('OAuth token subject missing');
    const nowSec = Math.floor(now / 1000);
    if (typeof claims.exp === 'number' && nowSec > claims.exp + this.clockSkewSec) throw new Error('OAuth token expired');
    const principal = {
      typ: 'user', sub: claims.sub, tenant: tenantFromClaims(claims, this.tenantClaim),
      scopes: scopesFromClaims(claims), iss: claims.iss || this.issuer, aud: claims.aud, exp: claims.exp, external: true
    };
    const maxTtl = typeof claims.exp === 'number' ? Math.max(1000, Math.min(30_000, claims.exp * 1000 - now)) : 15_000;
    this.introspectionCache.set(key, { principal, expiresAt: now + maxTtl });
    if (this.introspectionCache.size > 1000) this.introspectionCache.delete(this.introspectionCache.keys().next().value);
    return principal;
  }
}
