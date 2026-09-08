import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(16).toString('base64url')}`;
}

export function randomCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function sha256(value) {
  const data = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalize(value);
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key, value) {
  const data = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalize(value);
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function parseKey(value, name) {
  if (!value) throw new Error(`${name} is required`);
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64url'); } catch { key = null; }
  }
  if (!key || key.length !== 32) throw new Error(`${name} must be exactly 32 bytes (64 hex chars or base64url)`);
  return key;
}

export class EnvelopeCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('EnvelopeCipher requires a 32-byte key');
    this.key = key;
  }

  seal(value, aad = '') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url')
    };
  }

  open(envelope, aad = '') {
    if (!envelope || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('Unsupported encrypted envelope');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(envelope.iv, 'base64url')
    );
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }
}
