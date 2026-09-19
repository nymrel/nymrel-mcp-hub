/** HMAC-SHA256 and Ed25519 signing over canonical payloads. */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalize, type CanonicalizationProfile } from './canonical.js';

export type SignatureAlgorithm = 'HMAC-SHA256' | 'Ed25519';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
  algorithm: 'Ed25519';
  encoding: 'raw-hex';
}

export interface SignatureRecord {
  algorithm: SignatureAlgorithm;
  keyId: string;
  signerIdentity: string;
  value: string;
  timestamp: string;
}

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
const HMAC_SIGNATURE = /^[0-9a-fA-F]{64}$/;
const ED25519_SIGNATURE = /^[0-9a-fA-F]{128}$/;
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateEd25519Key(material: string): KeyObject {
  if (HEX_32_BYTES.test(material)) {
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(material, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  const key = createPrivateKey(material);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Private key is not Ed25519');
  return key;
}

function publicEd25519Key(material: string): KeyObject {
  if (HEX_32_BYTES.test(material)) {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(material, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  }
  const key = createPublicKey(material);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Public key is not Ed25519');
  return key;
}

export class ProofSigner {
  public static generateSecretKey(): string {
    return randomBytes(32).toString('hex');
  }

  public static generateKeyPair(): KeyPair {
    const pair = generateKeyPairSync('ed25519');
    const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
    return {
      privateKey: privateDer.subarray(privateDer.length - 32).toString('hex'),
      publicKey: publicDer.subarray(publicDer.length - 32).toString('hex'),
      algorithm: 'Ed25519',
      encoding: 'raw-hex',
    };
  }

  public static signPayload(
    payload: unknown,
    privateKeyOrSecret: string,
    algorithm: SignatureAlgorithm = 'HMAC-SHA256',
    canonicalizationProfile: CanonicalizationProfile = 'rfc8785'
  ): string {
    const canonicalPayload = typeof payload === 'string'
      ? payload
      : canonicalize(payload, canonicalizationProfile);
    const payloadBuffer = Buffer.from(canonicalPayload, 'utf8');
    if (algorithm === 'HMAC-SHA256') {
      return createHmac('sha256', privateKeyOrSecret).update(payloadBuffer).digest('hex');
    }
    if (algorithm === 'Ed25519') {
      return cryptoSign(null, payloadBuffer, privateEd25519Key(privateKeyOrSecret)).toString('hex');
    }
    throw new Error(`Unsupported signature algorithm: ${String(algorithm)}`);
  }

  public static verifySignature(
    payload: unknown,
    signatureHex: string,
    publicKeyOrSecret: string,
    algorithm: SignatureAlgorithm = 'HMAC-SHA256',
    canonicalizationProfile: CanonicalizationProfile = 'rfc8785'
  ): boolean {
    try {
      const canonicalPayload = typeof payload === 'string'
        ? payload
        : canonicalize(payload, canonicalizationProfile);
      const payloadBuffer = Buffer.from(canonicalPayload, 'utf8');
      if (algorithm === 'HMAC-SHA256') {
        if (!HMAC_SIGNATURE.test(signatureHex)) return false;
        const expected = createHmac('sha256', publicKeyOrSecret).update(payloadBuffer).digest();
        return timingSafeEqual(Buffer.from(signatureHex, 'hex'), expected);
      }
      if (algorithm === 'Ed25519') {
        if (!ED25519_SIGNATURE.test(signatureHex)) return false;
        return cryptoVerify(
          null,
          payloadBuffer,
          publicEd25519Key(publicKeyOrSecret),
          Buffer.from(signatureHex, 'hex')
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  public static createSignatureRecord(
    payload: unknown,
    privateKeyOrSecret: string,
    signerIdentity: string,
    keyId: string,
    algorithm: SignatureAlgorithm = 'HMAC-SHA256',
    canonicalizationProfile: CanonicalizationProfile = 'rfc8785'
  ): SignatureRecord {
    return {
      algorithm,
      keyId,
      signerIdentity,
      value: ProofSigner.signPayload(payload, privateKeyOrSecret, algorithm, canonicalizationProfile),
      timestamp: new Date().toISOString(),
    };
  }
}
