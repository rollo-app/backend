export type RateLimitBucket = "global" | "ip" | "expensive" | "files";

export interface RateLimiter {
  /** Consumes one hit of `key` in the bucket. True if the request may go through. Implementations fail open. */
  limit(bucket: RateLimitBucket, key: string): Promise<boolean>;
}
