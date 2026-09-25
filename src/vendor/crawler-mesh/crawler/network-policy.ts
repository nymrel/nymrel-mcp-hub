/**
 * Outbound HTTP policy shared by the crawler, sitemap reader, and CLI.
 * The default is intentionally fail closed for local and non-global targets.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Client, fetch as undiciFetch } from 'undici';

export type CrawlerSecurityErrorCode =
  | 'INVALID_URL'
  | 'UNSAFE_URL_CREDENTIALS'
  | 'PRIVATE_NETWORK_TARGET'
  | 'DNS_RESOLUTION_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'RESPONSE_TOO_LARGE';

export class CrawlerSecurityError extends Error {
  public readonly code: CrawlerSecurityErrorCode;

  constructor(code: CrawlerSecurityErrorCode) {
    super(`Crawler request rejected: ${code}`);
    this.name = 'CrawlerSecurityError';
    this.code = code;
  }
}

export interface NetworkPolicyOptions {
  /** Allow loopback, private, link-local, and other non-global targets. Default: false. */
  allowPrivateNetworks?: boolean;
  /** Maximum decoded response body in bytes. Default: 10 MiB. */
  maxResponseBytes?: number;
  /** Maximum number of followed redirects. Default: 5. */
  maxRedirects?: number;
  /** Resolver override for deterministic tests and controlled runtimes. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface SafeFetchOptions extends NetworkPolicyOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface ResolvedHttpTarget {
  url: URL;
  hostname: string;
  addresses: ResolvedAddress[];
}

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

const NON_GLOBAL = new BlockList();
const GLOBAL_IPV6 = new BlockList();

// The IANA global-unicast allocation is 2000::/3. Special-purpose ranges
// inside it are denied separately below. Everything outside it fails closed.
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  NON_GLOBAL.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  NON_GLOBAL.addSubnet(address, prefix, 'ipv6');
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isNonGlobalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_GLOBAL.check(address, 'ipv4');
  if (family === 6) {
    return !GLOBAL_IPV6.check(address, 'ipv6') || NON_GLOBAL.check(address, 'ipv6');
  }
  return true;
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) return [hostname];

  const records = await lookup(hostname, { all: true, order: 'verbatim' });
  return records.map(record => record.address);
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Network limits must be positive safe integers');
  }
  return value;
}

export async function assertSafeHttpUrl(
  input: string | URL,
  options: NetworkPolicyOptions = {}
): Promise<URL> {
  return (await resolveHttpTarget(input, options)).url;
}

async function resolveHttpTarget(
  input: string | URL,
  options: NetworkPolicyOptions = {}
): Promise<ResolvedHttpTarget> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new CrawlerSecurityError('INVALID_URL');
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new CrawlerSecurityError('INVALID_URL');
  }

  if (url.username || url.password) {
    throw new CrawlerSecurityError('UNSAFE_URL_CREDENTIALS');
  }

  const hostname = hostnameWithoutBrackets(url.hostname);
  let addresses: string[];
  try {
    addresses = isIP(hostname) !== 0
      ? [hostname]
      : await (options.resolveHostname ?? defaultResolver)(hostname);
  } catch {
    throw new CrawlerSecurityError('DNS_RESOLUTION_FAILED');
  }

  const resolvedAddresses: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new CrawlerSecurityError('DNS_RESOLUTION_FAILED');
    }
    if (seen.has(address)) continue;
    seen.add(address);
    resolvedAddresses.push({ address, family });
  }

  if (resolvedAddresses.length === 0) {
    throw new CrawlerSecurityError('DNS_RESOLUTION_FAILED');
  }

  if (!options.allowPrivateNetworks && resolvedAddresses.some(({ address }) => isNonGlobalAddress(address))) {
    throw new CrawlerSecurityError('PRIVATE_NETWORK_TARGET');
  }

  return { url, hostname, addresses: resolvedAddresses };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripSensitiveHeadersOnCrossOrigin(headers: Headers, from: URL, to: URL): void {
  if (from.origin === to.origin) return;
  headers.delete('authorization');
  headers.delete('cookie');
  headers.delete('proxy-authorization');
}

function pinnedLookup(target: ResolvedHttpTarget): LookupFunction {
  return (hostname, lookupOptions, callback): void => {
    if (hostnameWithoutBrackets(hostname).toLowerCase() !== target.hostname.toLowerCase()) {
      const error = new Error('Pinned resolver hostname mismatch') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }

    const requestedFamily = lookupOptions.family === 4 || lookupOptions.family === 6
      ? lookupOptions.family
      : 0;
    const candidates = requestedFamily === 0
      ? target.addresses
      : target.addresses.filter(({ family }) => family === requestedFamily);

    if (candidates.length === 0) {
      const error = new Error('No validated address for requested family') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', requestedFamily);
      return;
    }

    if (lookupOptions.all) {
      callback(null, candidates.map(({ address, family }) => ({ address, family })));
      return;
    }

    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

async function fetchPinned(
  target: ResolvedHttpTarget,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const client = new Client(target.url.origin, {
    connect: { lookup: pinnedLookup(target) },
    connectTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    pipelining: 0,
    maxCachedSessions: 0,
    autoSelectFamily: target.addresses.length > 1
  });

  try {
    const response = await undiciFetch(target.url, {
      ...init,
      dispatcher: client
    } as unknown as Parameters<typeof undiciFetch>[1]);

    // Graceful close waits for the response body to be consumed or cancelled,
    // so the validated address set is scoped to exactly this request.
    void client.close().catch(() => undefined);
    return response as unknown as Response;
  } catch (error) {
    await client.destroy(error instanceof Error ? error : null);
    throw error;
  }
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = normalizedPositiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
  const timeoutMs = normalizedPositiveInteger(options.timeoutMs, 15_000);
  let currentTarget = await resolveHttpTarget(input, options);
  let currentUrl = currentTarget.url;
  let method = init.method ?? 'GET';
  let body = init.body;
  const headers = new Headers(init.headers);
  // The validated URL, not caller input, owns HTTP authority routing.
  headers.delete('host');

  for (let redirects = 0; ; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;

    let response: Response;
    try {
      const requestInit: RequestInit = {
        ...init,
        method,
        body,
        headers,
        redirect: 'manual',
        signal
      };
      response = options.fetch
        ? await options.fetch(currentUrl, requestInit)
        : await fetchPinned(currentTarget, requestInit, timeoutMs);
    } finally {
      clearTimeout(timeout);
    }

    if (!isRedirect(response.status)) {
      return { response, finalUrl: currentUrl.toString() };
    }

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: currentUrl.toString() };
    if (redirects >= maxRedirects) {
      await response.body?.cancel();
      throw new CrawlerSecurityError('TOO_MANY_REDIRECTS');
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
      currentTarget = await resolveHttpTarget(nextUrl, options);
      nextUrl = currentTarget.url;
    } catch (error) {
      if (error instanceof CrawlerSecurityError) throw error;
      throw new CrawlerSecurityError('INVALID_URL');
    } finally {
      await response.body?.cancel();
    }
    stripSensitiveHeadersOnCrossOrigin(headers, currentUrl, nextUrl);

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-length');
      headers.delete('content-type');
    }

    currentUrl = nextUrl;
  }
}

export async function readResponseText(
  response: Response,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
): Promise<string> {
  const maxBytes = normalizedPositiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new CrawlerSecurityError('RESPONSE_TOO_LARGE');
    }
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CrawlerSecurityError('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
