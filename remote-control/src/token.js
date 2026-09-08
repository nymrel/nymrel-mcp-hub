import { canonicalize } from './canonical.js';
import { constantTimeEqual, hmacSha256, randomId } from './crypto.js';

const PREFIX = 'nr1';

function encode(value) {
  return Buffer.from(canonicalize(value), 'utf8').toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

export class TokenService {
  constructor(signingKey, { issuer = 'nymrel-remote', clockSkewSec = 30 } = {}) {
    this.signingKey = signingKey;
    this.issuer = issuer;
    this.clockSkewSec = clockSkewSec;
  }

  mint({ subject, tenantId = 'default', scopes = [], type = 'user', ttlSec = 3600, tokenVersion = 1, now = Date.now() }) {
    if (!subject) throw new Error('subject is required');
    if (!Array.isArray(scopes)) throw new Error('scopes must be an array');
    const iat = Math.floor(now / 1000);
    const payload = {
      v: 1,
      iss: this.issuer,
      sub: subject,
      tenant: tenantId,
      typ: type,
      scopes: [...new Set(scopes)].sort(),
      tokenVersion,
      iat,
      exp: iat + ttlSec,
      jti: randomId('tok_')
    };
    const encoded = encode(payload);
    const signature = hmacSha256(this.signingKey, `${PREFIX}.${encoded}`);
    return `${PREFIX}.${encoded}.${signature}`;
  }

  verify(token, { expectedType, requiredScopes = [], now = Date.now() } = {}) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('Invalid token');
    const [prefix, encoded, signature] = parts;
    const expected = hmacSha256(this.signingKey, `${prefix}.${encoded}`);
    if (!constantTimeEqual(signature, expected)) throw new Error('Invalid token signature');
    const payload = decode(encoded);
    const nowSec = Math.floor(now / 1000);
    if (payload.v !== 1 || payload.iss !== this.issuer) throw new Error('Invalid token claims');
    if (typeof payload.exp !== 'number' || nowSec > payload.exp + this.clockSkewSec) throw new Error('Token expired');
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + this.clockSkewSec) throw new Error('Token issued in the future');
    if (expectedType && payload.typ !== expectedType) throw new Error('Wrong token type');
    const scopes = new Set(payload.scopes ?? []);
    for (const scope of requiredScopes) {
      if (!scopes.has('*') && !scopes.has(scope)) throw new Error(`Missing required scope: ${scope}`);
    }
    return payload;
  }
}

export function bearerFromHeaders(headers) {
  const value = headers.authorization ?? headers.Authorization;
  if (!value || typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  return value.slice(7).trim();
}
