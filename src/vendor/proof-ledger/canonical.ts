/** RFC 8785 JSON Canonicalization Scheme (JCS) utilities. */

import { createHash } from 'node:crypto';

export type CanonicalizationProfile = 'rfc8785' | 'legacy';

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('RFC 8785 forbids lone UTF-16 surrogate code units');
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('RFC 8785 forbids lone UTF-16 surrogate code units');
    }
  }
}

function canonicalizeRfc8785(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('RFC 8785 forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new TypeError('RFC 8785 input must not contain sparse array elements');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)) {
        throw new TypeError('RFC 8785 input must not contain accessor properties');
      }
      elements.push(canonicalizeRfc8785(value[index]));
    }
    return `[${elements.join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('RFC 8785 input must contain only JSON objects');
    }

    const objectValue = value as Record<string, unknown>;
    if (Reflect.ownKeys(objectValue).some((key) => typeof key === 'symbol')) {
      throw new TypeError('RFC 8785 input must not contain symbol properties');
    }
    const keys = Object.keys(objectValue).sort();
    const entries = keys.map((key) => {
      assertUnicodeScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
      if (descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)) {
        throw new TypeError('RFC 8785 input must not contain accessor properties');
      }
      return `${JSON.stringify(key)}:${canonicalizeRfc8785(objectValue[key])}`;
    });
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`RFC 8785 cannot canonicalize ${typeof value}`);
}

/** Frozen v1 serializer retained only for existing receipt verification. */
export function canonicalizeLegacy(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) =>
      item === undefined || typeof item === 'symbol' || typeof item === 'function'
        ? 'null'
        : canonicalizeLegacy(item)
    ).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined && typeof objectValue[key] !== 'symbol' && typeof objectValue[key] !== 'function')
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeLegacy(objectValue[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported type for canonicalization: ${typeof value}`);
}

export function canonicalize(
  value: unknown,
  profile: CanonicalizationProfile = 'rfc8785'
): string {
  return profile === 'legacy' ? canonicalizeLegacy(value) : canonicalizeRfc8785(value);
}

export function canonicalHash(
  data: unknown,
  algorithm = 'sha256',
  profile: CanonicalizationProfile = 'rfc8785'
): string {
  return createHash(algorithm).update(canonicalize(data, profile), 'utf8').digest('hex');
}
