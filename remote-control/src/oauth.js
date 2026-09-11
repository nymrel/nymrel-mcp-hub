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

function tenantFromClaims(claims, claimName, defaultTenant = null) {
  if (!claimName || typeof claimName !== 'string') throw new Error('OAuth tenant claim configuration is invalid');
  const value = claims?.[claimName];
  if (value === undefined || value === null || value === '') {
    if (defaultTenant) return defaultTenant;
    throw new Error(`OAuth tenant claim missing: ${claimName}`);
  }
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`OAuth tenant claim ${claimName} is invalid`);
  }
  return value;
}

function issuerDiscoveryUrls(issuer) {
  const url = new URL(issuer);
  const base = `${url.protocol}//${url.host}`;
  const issuerPath = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!issuerPath) {
    return [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  }
  return [
    `${base}/.well-known/oauth-authorization-server/${issuerPath}`,
    `${base}/.well-known/openid-configuration/${issuerPath}`,
    `${base}/${issuerPath}/.well-known/openid-configuration`
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
  if (!cryptoVerify(alg, data, key, signature)) throw new Error('Invalid OAuth JWT signature');
}

export class OAuthAccessTokenVerifier {
  constructor({
    issuer,
    jwksUrl,
    audience,
    tenantClaim = 'tenant',
    defaultTenant = null,
    introspectionUrl,
    introspectionClientId,
    introspectionClientSecret,
    clockSkewSec = 30,
    requireHttps = false,
    fetchTimeoutMs = 5000,
    maxDocumentBytes = 1024 * 1024,
    fetchImpl = fetch
  } = {}) {
    this.issuer = issuer?.replace(/\/$/, '') || null;
    this.jwksUrl = jwksUrl || null;
    this.audience = audience || null;
    this.tenantClaim = tenantClaim;
    this.defaultTenant = defaultTenant;
    this.introspectionUrl = introspectionUrl || null;
    this.introspectionClientId = introspectionClientId || null;
    this.introspectionClientSecret = introspectionClientSecret || null;
    this.clockSkewSec = clockSkewSec;
    this.requireHttps = requireHttps;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.maxDocumentBytes = maxDocumentBytes;
    this.fetch = fetchImpl;
    this.metadataCache = null;
    this.jwksCache = null;
    this.jwksRefreshPromise = null;
    this.lastForcedJwksRefreshAt = 0;
    this.unknownKidUntil = new Map();
    this.introspectionCache = new Map();
    for (const [value, name] of [[this.issuer, 'issuer'], [this.jwksUrl, 'JWKS URL'], [this.introspectionUrl, 'introspection URL']]) {
      if (value) this.#assertTrustedUrl(value, name);
    }
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
    let candidates = jwks.keys.filter((key) => !header.kid || key.kid === header.kid);
    if (candidates.length === 0 && header.kid) {
      const retryAt = this.unknownKidUntil.get(header.kid) || 0;
      if (retryAt > now) throw new Error('OAuth JWT signing key not found');
      const refreshed = await this.#forceJwksRefresh(now);
      candidates = refreshed.keys.filter((key) => key.kid === header.kid);
      if (candidates.length === 0) {
        this.unknownKidUntil.set(header.kid, now + 5000);
        if (this.unknownKidUntil.size > 1000) this.unknownKidUntil.delete(this.unknownKidUntil.keys().next().value);
        throw new Error('OAuth JWT signing key not found');
      }
    }
    if (candidates.length === 0) throw new Error('OAuth JWT signing key not found');
    let verified = false;
    for (const key of candidates) {
      try { verifyJwtSignature(token, header, key); verified = true; break; } catch { /* try next key */ }
    }
    if (!verified) throw new Error('Invalid OAuth JWT signature');

    return {
      typ: 'user',
      sub: claims.sub,
      tenant: tenantFromClaims(claims, this.tenantClaim, this.defaultTenant),
      scopes: scopesFromClaims(claims),
      iss: claims.iss,
      aud: claims.aud,
      exp: claims.exp,
      external: true
    };
  }

  async #forceJwksRefresh(now) {
    if (this.jwksRefreshPromise) return this.jwksRefreshPromise;
    if (now - this.lastForcedJwksRefreshAt < 5000 && this.jwksCache) return this.jwksCache.value;
    this.lastForcedJwksRefreshAt = now;
    this.jwksRefreshPromise = this.#getJwks(true).finally(() => { this.jwksRefreshPromise = null; });
    return this.jwksRefreshPromise;
  }

  async #getJwks(force = false) {
    const now = Date.now();
    if (!force && this.jwksCache && this.jwksCache.expiresAt > now) return this.jwksCache.value;
    let url = this.jwksUrl;
    if (!url) {
      const metadata = await this.#getMetadata();
      url = metadata.jwks_uri;
      if (typeof url !== 'string') throw new Error('Authorization server metadata has no jwks_uri');
    }
    const value = await this.#fetchJson(url, { headers: { accept: 'application/json' } }, 'JWKS');
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
        const value = await this.#fetchJson(url, { headers: { accept: 'application/json' } }, 'authorization metadata');
        if (value?.issuer !== this.issuer) throw new Error('Authorization server metadata issuer mismatch');
        this.metadataCache = { value, expiresAt: now + 10 * 60 * 1000 };
        return value;
      } catch (error) { lastError = error; }
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
    const claims = await this.#fetchJson(this.introspectionUrl, {
      method: 'POST', headers, body: new URLSearchParams({ token })
    }, 'OAuth introspection');
    if (claims?.active !== true) throw new Error('OAuth token is inactive');
    if (this.issuer && claims.iss !== this.issuer) throw new Error('OAuth issuer mismatch');
    if (!audienceMatches(claims.aud, this.audience)) throw new Error('OAuth token audience mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('OAuth token subject missing');
    const nowSec = Math.floor(now / 1000);
    if (typeof claims.exp === 'number' && nowSec > claims.exp + this.clockSkewSec) throw new Error('OAuth token expired');
    const principal = {
      typ: 'user', sub: claims.sub, tenant: tenantFromClaims(claims, this.tenantClaim, this.defaultTenant),
      scopes: scopesFromClaims(claims), iss: claims.iss || this.issuer, aud: claims.aud, exp: claims.exp, external: true
    };
    const maxTtl = typeof claims.exp === 'number' ? Math.max(1000, Math.min(30_000, claims.exp * 1000 - now)) : 15_000;
    this.introspectionCache.set(key, { principal, expiresAt: now + maxTtl });
    if (this.introspectionCache.size > 1000) this.introspectionCache.delete(this.introspectionCache.keys().next().value);
    return principal;
  }

  #assertTrustedUrl(value, name) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${name} is not a valid URL`); }
    if (this.requireHttps && parsed.protocol !== 'https:') throw new Error(`${name} must use https`);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`${name} uses an unsupported URL scheme`);
  }

  async #fetchJson(url, init, label) {
    this.#assertTrustedUrl(url, label);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (response.url) this.#assertTrustedUrl(response.url, `${label} response URL`);
    if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status}`);
    const declared = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > this.maxDocumentBytes) throw new Error(`${label} document exceeds size limit`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxDocumentBytes) throw new Error(`${label} document exceeds size limit`);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`${label} returned malformed JSON`); }
  }
}