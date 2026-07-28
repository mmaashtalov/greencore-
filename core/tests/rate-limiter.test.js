import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limiter.js';

test('fixed window rate limit returns headers and resets deterministically', () => {
  let now = Date.parse('2026-07-28T10:00:00Z');
  const limiter = new RateLimiter({
    policies: { read: { limit: 2, windowMs: 60000 } },
    now: () => now
  });

  const first = limiter.enforce('read', 'client-a');
  const second = limiter.enforce('read', 'client-a');
  assert.equal(first.remaining, 1);
  assert.equal(second.remaining, 0);
  assert.throws(() => limiter.enforce('read', 'client-a'), error => {
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfterSeconds, 60);
    assert.equal(error.rateLimit.remaining, 0);
    return true;
  });

  now += 60000;
  assert.equal(limiter.enforce('read', 'client-a').remaining, 1);
  assert.equal(limiter.status().denied, 1);
});

test('identities are isolated and tracked set is bounded', () => {
  const limiter = new RateLimiter({
    policies: { controller: { limit: 1, windowMs: 60000 } },
    maxIdentities: 2,
    now: () => 1000
  });
  limiter.enforce('controller', 'a');
  limiter.enforce('controller', 'b');
  limiter.enforce('controller', 'c');
  assert.equal(limiter.status().tracked_identities, 2);
  assert.equal(limiter.status().evicted_identities, 1);
});
