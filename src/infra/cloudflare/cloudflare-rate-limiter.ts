import type { RateLimitBucket, RateLimiter } from "../../ports/rate-limiter";
import type { RateLimitBinding } from "../../types";

export type RateLimitBindings = Partial<Record<RateLimitBucket, RateLimitBinding | undefined>>;

const warned = new Set<string>();

/** `RateLimiter` on the Workers Rate Limiting bindings (`ratelimits` in wrangler.jsonc). Fails open. */
export class CloudflareRateLimiter implements RateLimiter {
  constructor(private readonly bindings: RateLimitBindings) {}

  async limit(bucket: RateLimitBucket, key: string): Promise<boolean> {
    const name = `RL_${bucket.toUpperCase()}`;
    const binding = this.bindings[bucket];
    if (!binding) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[rate-limit] binding ${name} is missing: not limiting`);
      }
      return true;
    }
    try {
      return (await binding.limit({ key })).success;
    } catch (err) {
      console.error(`[rate-limit] ${name} failed`, err);
      return true;
    }
  }
}
