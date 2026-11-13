import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { hashToken } from "./auth";
import { ipKey } from "./ip";
import type { AppEnv, Env, RateLimitBinding } from "../types";

export const RATE_LIMIT_MESSAGE = "Estás yendo muy rápido. Probá de nuevo en un minuto.";

type LimiterName = "RL_GLOBAL" | "RL_IP" | "RL_IP_FILES" | "RL_IP_PUBLIC" | "RL_EXPENSIVE" | "RL_UPLOAD" | "RL_FILES" | "RL_SEARCH";
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

/**
 * Speed-limit 429. Carries `Retry-After` (the windows are 60 s) so the app knows this one is worth retrying; the quota 429s
 * (`rateLimited` in shared/errors.ts) deliberately do not. onError copies the header (see index.ts).
 */
const tooFast = () =>
  new HTTPException(429, { message: RATE_LIMIT_MESSAGE, res: new Response(null, { status: 429, headers: { "Retry-After": "60" } }) });

/** Per-route limiter keyed by user id: use after `requireUser`. */
export const rateLimit = (name: "RL_EXPENSIVE" | "RL_UPLOAD" | "RL_FILES" | "RL_SEARCH") =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!(await allowed(c.env, name, `u:${c.get("user").id}`))) throw tooFast();
    await next();
  });

/** Per-route limiter keyed by client IP, for routes without a session. */
export const rateLimitByIp = (name: "RL_IP_PUBLIC") =>
  createMiddleware<AppEnv>(async (c, next) => {
    const rawIp = c.req.header("cf-connecting-ip");
    if (!(await allowed(c.env, name, `ip:${rawIp ? ipKey(rawIp) : "unknown"}`))) throw tooFast();
    await next();
  });

/** Paths that cost nothing (static docs, the dev upload) and are not limited. */
const SKIPPED = new Set(["/openapi.json", "/docs"]);

/**
 * File downloads: `GET /trips/{tripId}/media/{mediaId}/{thumb|original}` and `GET /featured/{userId}/{mediaId}/{variant}`.
 * They have their own per-user limiter (`RL_FILES`) and a gallery loads hundreds of thumbnails at once, so counting them
 * against `RL_GLOBAL` (120/min per session) cut the scroll short and then blocked the feed and everything else too.
 * With a Bearer token they skip `RL_IP` too: at an event many guests share one IP (venue Wi-Fi, carrier NAT), and browsing a
 * 2,000-photo rollo filled the 600/60 s per-IP budget, which then blocked every route for that IP. They are limited per
 * user by `RL_FILES` (after `requireUser`). Trade-off: a shared IP gets a separate, 5x larger budget (`RL_IP_FILES`, 3000/60 s)
 * only for files, so files never cut the feed and the rest, and invented tokens on these paths are capped per IP again (each
 * costs a session lookup that fails with 401). Every other route keeps `RL_IP`. Without a token they keep `RL_GLOBAL` by IP.
 */
const FILE_DOWNLOAD = /^\/(?:trips\/[^/]+\/media\/[^/]+\/(?:thumb|original)|featured\/[^/]+\/[^/]+\/[^/]+)$/;

/**
 * `GET|OPTIONS /events/{code}`: the public event preview the website loads for every guest who opens the invite link.
 * Anonymous, so `RL_GLOBAL` by IP (120/min) would cut a whole venue on one Wi-Fi or carrier NAT. It skips that and has its
 * own roomy per-IP budget on the route (`RL_IP_PUBLIC`, see `rateLimitByIp`).
 */
const PUBLIC_EVENT_PREVIEW = /^\/events\/[^/]+$/;

/**
 * App-level limiter, before auth runs. It keys by a hash of the Bearer token (one key per session, so friends sharing
 * a Wi-Fi or mobile IP do not share a budget) or, without token, by IP. Tokens are not validated here, so with a token
 * the IP also gets a roomier `RL_IP` budget: inventing tokens does not dodge the limit (file downloads get their own per-IP `RL_IP_FILES`, see above).
 */
export const globalRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (SKIPPED.has(path) || path.startsWith("/dev/upload/") || PUBLIC_EVENT_PREVIEW.test(path)) return next();
  const rawIp = c.req.header("cf-connecting-ip");
  const ip = rawIp ? ipKey(rawIp) : "unknown";
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    // Without a token (anonymous) downloads keep RL_GLOBAL by IP below: they get 401 anyway and nothing is gained by skipping.
    if (FILE_DOWNLOAD.test(path)) {
      if (!(await allowed(c.env, "RL_IP_FILES", `ip:${ip}`))) throw tooFast();
    } else {
      if (!(await allowed(c.env, "RL_GLOBAL", `t:${(await hashToken(token)).slice(0, 32)}`))) throw tooFast();
      if (!(await allowed(c.env, "RL_IP", `ip:${ip}`))) throw tooFast();
    }
  } else if (!(await allowed(c.env, "RL_GLOBAL", `ip:${ip}`))) {
    throw tooFast();
  }
  await next();
});
