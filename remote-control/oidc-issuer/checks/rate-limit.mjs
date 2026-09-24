import test from 'node:test';
import assert from 'node:assert/strict';
import { createIssuerRateLimiter, ISSUER_RATE_LIMITS } from '../src/rate-limit.js';

test('fixed buckets bound bursts, refill gradually, and remain independent', () => {
  let clock = 0;
  const limit = createIssuerRateLimiter(() => clock);
  for (const [name, path] of [['interaction', '/auth'], ['google', '/google/callback'], ['token', '/token']]) {
    for (let i = 0; i < ISSUER_RATE_LIMITS[name]; i++) assert.equal(limit(path, 'POST'), 0);
    assert.equal(limit(path, 'POST'), 60 / ISSUER_RATE_LIMITS[name]);
  }
  for (let i = 0; i < 100; i++) assert.equal(limit('/jwks', 'GET'), 0);
  assert.ok(limit('/jwks', 'POST'));
  clock = 1000;
  assert.equal(limit('/token/revocation', 'POST'), 0);
  assert.equal(limit('/token/', 'POST'), 1);
  assert.equal(limit('/google/callback', 'GET'), 2);
  clock = 0; // A backwards clock cannot replenish a bucket.
  assert.equal(limit('/token', 'POST'), 1);
  clock = 120000;
  for (let i = 0; i < 60; i++) assert.equal(limit(`/interaction/random-${i}/start`, 'POST'), 0);
  assert.equal(limit('/auth/arbitrary/resume', 'GET'), 1);
  assert.equal(limit('/unknown', 'GET'), 1);
});
