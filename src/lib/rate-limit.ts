import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { hashToken } from "./auth";
import type { AppEnv, Env, RateLimitBinding } from "../types";

export const RATE_LIMIT_MESSAGE = "Estás yendo muy rápido. Probá de nuevo en un minuto.";

type LimiterName = "RL_GLOBAL" | "RL_IP" | "RL_EXPENSIVE" | "RL_FILES";
const warned = new Set<string>();

/** Consumes one hit of `key`. Fails open: without the binding (or if it throws) the request goes through. */
async function allowed(env: Env, name: LimiterName, key: string): Promise<boolean> {
  const binding: RateLimitBinding | undefined = env[name];
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

const tooFast = () => new HTTPException(429, { message: RATE_LIMIT_MESSAGE });

/** Per-route limiter keyed by user id: use after `requireUser`. */
export const rateLimit = (name: "RL_EXPENSIVE" | "RL_FILES") =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!(await allowed(c.env, name, `u:${c.get("user").id}`))) throw tooFast();
    await next();
  });

/** Paths that cost nothing (static docs, the dev upload) and are not limited. */
const SKIPPED = new Set(["/openapi.json", "/docs"]);

/**
 * App-level limiter, before auth runs. It keys by a hash of the Bearer token (one key per session, so friends sharing
 * a Wi-Fi or mobile IP do not share a budget) or, without token, by IP. Tokens are not validated here, so with a token
 * the IP also gets a roomier `RL_IP` budget: inventing tokens does not dodge the limit.
 */
export const globalRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (SKIPPED.has(path) || path.startsWith("/dev/upload/")) return next();
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    if (!(await allowed(c.env, "RL_GLOBAL", `t:${(await hashToken(token)).slice(0, 32)}`))) throw tooFast();
    if (!(await allowed(c.env, "RL_IP", `ip:${ip}`))) throw tooFast();
  } else if (!(await allowed(c.env, "RL_GLOBAL", `ip:${ip}`))) {
    throw tooFast();
  }
  await next();
});
