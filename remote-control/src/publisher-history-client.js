import { NymrelRemoteError } from './errors.js';

const URL_ENV = 'NYMREL_PUBLISHER_HISTORY_URL';
const TOKEN_ENV = 'NYMREL_PUBLISHER_HISTORY_TOKEN';
const BRANDS_ENV = 'NYMREL_PUBLISHER_HISTORY_TENANT_BRANDS';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const bounded = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;

function parseTenantBrands(raw) {
  if (!raw) return new Map();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${BRANDS_ENV} must be a JSON object`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${BRANDS_ENV} must be a JSON object`);
  const entries = Object.entries(parsed);
  if (entries.length > 32) throw new Error(`${BRANDS_ENV} supports at most 32 tenants`);
  const result = new Map();
  for (const [tenant, brands] of entries) {
    if (!bounded(tenant, 128) || !Array.isArray(brands) || brands.length < 1 || brands.length > 64 ||
        brands.some((brand) => !bounded(brand)) || new Set(brands).size !== brands.length) {
      throw new Error(`${BRANDS_ENV} contains an invalid tenant brand mapping`);
    }
    result.set(tenant, new Set(brands));
  }
  return result;
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new NymrelRemoteError(
    'Publisher history response exceeded its bound', { code: 'PUBLISHER_HISTORY_RESPONSE_TOO_LARGE', status: 502 });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new NymrelRemoteError(
    'Publisher history response exceeded its bound', { code: 'PUBLISHER_HISTORY_RESPONSE_TOO_LARGE', status: 502 });
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new NymrelRemoteError('Publisher history returned invalid JSON', { code: 'PUBLISHER_HISTORY_INVALID_RESPONSE', status: 502 }); }
  return parsed;
}

export class PublisherHistoryClient {
  constructor({ baseUrl, token, tenantBrands, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { parsed = null; }
    const privateRailway = parsed?.protocol === 'http:' && parsed.hostname.endsWith('.railway.internal');
    const secureOrigin = parsed?.protocol === 'https:' || privateRailway;
    if (!parsed || !secureOrigin || parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== '/' || !bounded(token, 4096) || !(tenantBrands instanceof Map) ||
        typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new TypeError('Publisher history client configuration is invalid');
    }
    this.baseUrl = parsed.origin;
    this.token = token;
    this.tenantBrands = tenantBrands;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  allowedBrands(tenant) {
    return new Set(this.tenantBrands.get(tenant) ?? []);
  }

  assertBrand(tenant, brandId) {
    if (!bounded(tenant, 128) || !bounded(brandId) || !this.tenantBrands.get(tenant)?.has(brandId)) {
      throw new NymrelRemoteError('Publisher brand is not available to this OAuth tenant', {
        code: 'PUBLISHER_HISTORY_BRAND_DENIED', status: 404
      });
    }
  }

  async #post(pathname, args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json'
        },
        body: JSON.stringify(args)
      });
    } catch (error) {
      if (controller.signal.aborted) throw new NymrelRemoteError('Publisher history request timed out', {
        code: 'PUBLISHER_HISTORY_TIMEOUT', status: 504
      });
      throw new NymrelRemoteError('Publisher history request failed', { code: 'PUBLISHER_HISTORY_UNAVAILABLE', status: 502 });
    } finally {
      clearTimeout(timer);
    }
    const payload = await boundedJson(response);
    if (!response.ok || payload?.ok !== true) {
      const code = bounded(payload?.error, 128) ? payload.error : 'PUBLISHER_HISTORY_UPSTREAM_ERROR';
      throw new NymrelRemoteError('Publisher history request was rejected', { code, status: response.status || 502 });
    }
    return payload.result;
  }

  async listRecent(tenant, args) {
    this.assertBrand(tenant, args.brandId);
    return this.#post('/v1/history/recent', args);
  }

  async findExactText(tenant, args) {
    this.assertBrand(tenant, args.brandId);
    return this.#post('/v1/history/exact-text', args);
  }

  async listSyncs(tenant, args) {
    this.assertBrand(tenant, args.brandId);
    return this.#post('/v1/history/syncs', args);
  }
}

export function createPublisherHistoryClientFromEnv({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = env[URL_ENV];
  const token = env[TOKEN_ENV];
  const tenantBrands = parseTenantBrands(env[BRANDS_ENV]);
  const configured = Boolean(baseUrl || token || tenantBrands.size);
  if (!configured) return null;
  if (!baseUrl || !token || tenantBrands.size === 0) {
    throw new Error(`${URL_ENV}, ${TOKEN_ENV}, and ${BRANDS_ENV} must be configured together`);
  }
  if (token.length < 32) throw new Error(`${TOKEN_ENV} must contain at least 32 characters`);
  return new PublisherHistoryClient({ baseUrl, token, tenantBrands, fetchImpl });
}
