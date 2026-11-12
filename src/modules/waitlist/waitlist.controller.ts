import type { RouteHandler } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types";
import { CONFIRMED_PAGE, INVALID_LINK_PAGE, UNSUBSCRIBED_PAGE } from "./waitlist.pages";
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
  return c.html(html, status, { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
}

export async function confirm(c: Context<AppEnv>) {
  const ok = await service.confirmWaitlist(c.env.DB, c.req.query("token"));
  return ok ? page(c, CONFIRMED_PAGE, 200) : page(c, INVALID_LINK_PAGE, 400);
}

export async function unsubscribe(c: Context<AppEnv>) {
  const ok = await service.unsubscribeWaitlist(c.env.DB, c.req.query("token"));
  return ok ? page(c, UNSUBSCRIBED_PAGE, 200) : page(c, INVALID_LINK_PAGE, 400);
}
