import { performance } from 'node:perf_hooks';

// One issuer process, three fixed buckets: attacker-controlled values never
// allocate state or select a new budget. A burst refills over one minute.
export const ISSUER_RATE_LIMITS = Object.freeze({ interaction: 60, google: 20, token: 60 });
const publicPaths = new Set(['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/jwks']);

export function createIssuerRateLimiter(now = () => performance.now()) {
  const buckets = new Map(Object.entries(ISSUER_RATE_LIMITS).map(([name, capacity]) =>
    [name, { capacity, credit: capacity * 60000, updated: now() }]));
  return (pathname, method) => {
    if (method === 'GET' && publicPaths.has(pathname)) return 0;
    const name = pathname.startsWith('/google/callback') ? 'google'
      : pathname.startsWith('/token') ? 'token' : 'interaction';
    const bucket = buckets.get(name);
    const current = Math.max(bucket.updated, now());
    bucket.credit = Math.min(bucket.capacity * 60000, bucket.credit + (current - bucket.updated) * bucket.capacity);
    bucket.updated = current;
    if (bucket.credit < 60000) return Math.max(1, Math.ceil((60000 - bucket.credit) / bucket.capacity / 1000));
    bucket.credit -= 60000;
    return 0;
  };
}
