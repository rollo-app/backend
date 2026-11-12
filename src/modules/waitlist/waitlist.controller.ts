import type { RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types";
import { CONFIRMED_PAGE, confirmPage, INVALID_LINK_PAGE, UNSUBSCRIBED_PAGE, unsubscribePage } from "./waitlist.pages";
import type { joinRoute } from "./waitlist.router";
import * as service from "./waitlist.service";

export const join: RouteHandler<typeof joinRoute, AppEnv> = async (c) => {
  const { email, source } = c.req.valid("json");
  const result = await service.joinWaitlist(c.env, {
    email,
    source,
    rawIp: c.req.header("cf-connecting-ip"),
    // The links point at whatever host served this request (the API host in production).
    origin: new URL(c.req.url).origin,
  });
  // 502 has no AppError kind, so it stays an HTTPException here.
  if (result === "send_failed") throw new HTTPException(502, { message: "No pudimos mandar el email, probá de nuevo" });
  return c.body(null, 204);
};

/** Pages: the token is in the URL, so they are never cached and never leak it through the Referer. */
function page(c: Context<AppEnv>, html: string, status: 200 | 400) {
  return c.html(html, status, {
    "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

/** The token comes in the query (the emailed link, the RFC 8058 one-click POST) or in the form body (the page button). */
async function tokenOf(c: Context<AppEnv>): Promise<string | undefined> {
  const fromQuery = c.req.query("token");
  if (fromQuery) return fromQuery;
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return typeof form.token === "string" ? form.token : undefined;
}

// GET only shows the button (read-only: mail scanners open every link); the POST acts.
export async function confirmPageGet(c: Context<AppEnv>) {
  const token = c.req.query("token");
  return token && (await service.peekWaitlist(c.env.DB, "confirm", token)) ? page(c, confirmPage(token), 200) : page(c, INVALID_LINK_PAGE, 400);
}

export async function unsubscribePageGet(c: Context<AppEnv>) {
  const token = c.req.query("token");
  return token && (await service.peekWaitlist(c.env.DB, "unsubscribe", token)) ? page(c, unsubscribePage(token), 200) : page(c, INVALID_LINK_PAGE, 400);
}

export async function confirm(c: Context<AppEnv>) {
  const ok = await service.confirmWaitlist(c.env.DB, await tokenOf(c));
  return ok ? page(c, CONFIRMED_PAGE, 200) : page(c, INVALID_LINK_PAGE, 400);
}

export async function unsubscribe(c: Context<AppEnv>) {
  const ok = await service.unsubscribeWaitlist(c.env.DB, await tokenOf(c));
  return ok ? page(c, UNSUBSCRIBED_PAGE, 200) : page(c, INVALID_LINK_PAGE, 400);
}
