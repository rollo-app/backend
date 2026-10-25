import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { hashToken } from "./auth";
import { ipKey } from "./ip";
import type { RateLimitBucket } from "../ports/rate-limiter";
import type { AppEnv } from "../types";

export const RATE_LIMIT_MESSAGE = "Estás yendo muy rápido. Probá de nuevo en un minuto.";

const tooFast = () => new HTTPException(429, { message: RATE_LIMIT_MESSAGE });

/** Per-route limiter keyed by user id (bucket `expensive` or `files`): use after `requireUser`. */
export const rateLimit = (bucket: Extract<RateLimitBucket, "expensive" | "files">) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!(await c.get("deps").rateLimiter.limit(bucket, `u:${c.get("user").id}`))) throw tooFast();
    await next();
  });

/** Paths that cost nothing (static docs, the dev upload) and are not limited. */
const SKIPPED = new Set(["/openapi.json", "/docs"]);

/**
 * App-level limiter, before auth runs. It keys by a hash of the Bearer token (one key per session, so friends sharing
 * a Wi-Fi or mobile IP do not share a budget) or, without token, by IP. Tokens are not validated here, so with a token
 * the IP also gets a roomier `ip` budget: inventing tokens does not dodge the limit.
 */
export const globalRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { rateLimiter } = c.get("deps");
  const path = new URL(c.req.url).pathname;
  if (SKIPPED.has(path) || path.startsWith("/dev/upload/")) return next();
  const rawIp = c.req.header("cf-connecting-ip");
  const ip = rawIp ? ipKey(rawIp) : "unknown";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    if (!(await rateLimiter.limit("global", `t:${(await hashToken(token)).slice(0, 32)}`))) throw tooFast();
    if (!(await rateLimiter.limit("ip", `ip:${ip}`))) throw tooFast();
  } else if (!(await rateLimiter.limit("global", `ip:${ip}`))) {
    throw tooFast();
  }
  await next();
});
