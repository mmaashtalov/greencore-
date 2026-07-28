function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function rateLimitError(result) {
  const error = new Error(`Rate limit exceeded for ${result.policy}`);
  error.statusCode = 429;
  error.retryAfterSeconds = result.retry_after_seconds;
  error.rateLimit = result;
  return error;
}

export class RateLimiter {
  constructor({ policies = {}, now = () => Date.now(), maxIdentities = 10000 } = {}) {
    this.now = now;
    this.maxIdentities = positiveInteger(maxIdentities, 'maxIdentities');
    this.policies = new Map();
    for (const [name, policy] of Object.entries(policies)) {
      this.policies.set(name, {
        limit: positiveInteger(policy.limit, `${name}.limit`),
        windowMs: positiveInteger(policy.windowMs, `${name}.windowMs`)
      });
    }
    this.windows = new Map();
    this.metrics = { allowed: 0, denied: 0, evicted_identities: 0 };
  }

  static fromEnv(env = process.env) {
    const minute = 60_000;
    return new RateLimiter({
      policies: {
        read: { limit: env.RATE_LIMIT_READ_PER_MINUTE ?? 240, windowMs: minute },
        operator: { limit: env.RATE_LIMIT_OPERATOR_PER_MINUTE ?? 120, windowMs: minute },
        controller: { limit: env.RATE_LIMIT_CONTROLLER_PER_MINUTE ?? 1200, windowMs: minute },
        simulation: { limit: env.RATE_LIMIT_SIMULATION_PER_MINUTE ?? 12, windowMs: minute },
        stream: { limit: env.RATE_LIMIT_STREAM_PER_MINUTE ?? 30, windowMs: minute }
      },
      maxIdentities: env.RATE_LIMIT_MAX_IDENTITIES ?? 10000
    });
  }

  policy(name) {
    const policy = this.policies.get(name);
    if (!policy) throw new Error(`Unknown rate-limit policy: ${name}`);
    return policy;
  }

  evictIfNeeded(now) {
    if (this.windows.size < this.maxIdentities) return;
    for (const [key, value] of this.windows) {
      const policy = this.policies.get(value.policy);
      if (!policy || now - value.windowStart >= policy.windowMs) {
        this.windows.delete(key);
        this.metrics.evicted_identities += 1;
        if (this.windows.size < this.maxIdentities) return;
      }
    }
    const oldest = this.windows.keys().next().value;
    if (oldest !== undefined) {
      this.windows.delete(oldest);
      this.metrics.evicted_identities += 1;
    }
  }

  consume(policyName, identity = 'anonymous', cost = 1) {
    const policy = this.policy(policyName);
    const normalizedCost = positiveInteger(cost, 'cost');
    const now = Number(this.now());
    if (!Number.isFinite(now)) throw new Error('now must return epoch milliseconds');
    const key = `${policyName}:${identity}`;
    let state = this.windows.get(key);
    if (!state || now - state.windowStart >= policy.windowMs) {
      this.evictIfNeeded(now);
      state = { policy: policyName, windowStart: now, count: 0 };
      this.windows.delete(key);
      this.windows.set(key, state);
    }

    const resetAt = state.windowStart + policy.windowMs;
    const allowed = state.count + normalizedCost <= policy.limit;
    if (allowed) {
      state.count += normalizedCost;
      this.metrics.allowed += 1;
    } else {
      this.metrics.denied += 1;
    }
    this.windows.delete(key);
    this.windows.set(key, state);

    return {
      allowed,
      policy: policyName,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - state.count),
      reset_at: new Date(resetAt).toISOString(),
      retry_after_seconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
    };
  }

  enforce(policyName, identity, cost = 1) {
    const result = this.consume(policyName, identity, cost);
    if (!result.allowed) throw rateLimitError(result);
    return result;
  }

  status() {
    return {
      policies: Object.fromEntries([...this.policies].map(([name, policy]) => [name, {
        limit: policy.limit,
        window_ms: policy.windowMs
      }])),
      tracked_identities: this.windows.size,
      max_identities: this.maxIdentities,
      ...this.metrics
    };
  }

  reset() {
    this.windows.clear();
    this.metrics = { allowed: 0, denied: 0, evicted_identities: 0 };
  }
}

export { rateLimitError };
