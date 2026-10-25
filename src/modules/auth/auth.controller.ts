import type { RouteHandler } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { publicUser } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { logoutRoute, startRoute, verifyLinkRoute, verifyRoute } from "./auth.router";
import * as service from "./auth.service";

const present = (r: service.SignedIn) => ({ token: r.token, user: publicUser(r.user), isNew: r.isNew });

export const start: RouteHandler<typeof startRoute, AppEnv> = async (c) => {
  const { email, linkChallenge } = c.req.valid("json");
  const result = await service.startLogin(c.get("deps"), { email, linkChallenge, rawIp: c.req.header("cf-connecting-ip") });
  // 502 has no AppError kind, so it stays an HTTPException here.
  if (result === "send_failed") throw new HTTPException(502, { message: "No pudimos mandar el email, probá de nuevo" });
  return c.body(null, 204);
};

export const verify: RouteHandler<typeof verifyRoute, AppEnv> = async (c) => {
  const { email, code } = c.req.valid("json");
  return c.json(present(await service.verifyCode(c.get("deps").db, email, code)), 200);
};

export const verifyLink: RouteHandler<typeof verifyLinkRoute, AppEnv> = async (c) => {
  return c.json(present(await service.verifyLink(c.get("deps").db, c.req.valid("json"))), 200);
};

export const logout: RouteHandler<typeof logoutRoute, AppEnv> = async (c) => {
  await service.logout(c.get("deps").db, c.get("sessionId"));
  return c.body(null, 204);
};
