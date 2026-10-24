import type { RouteHandler } from "@hono/zod-openapi";
import { deferPush } from "../../lib/push";
import type { AppEnv } from "../../types";
import type { likeRoute, unlikeRoute } from "./likes.router";
import * as service from "./likes.service";

export const like: RouteHandler<typeof likeRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const { notify } = await service.likePhoto(c.env, user, c.req.valid("param").mediaId);
  if (notify) deferPush(c, notify());
  return c.body(null, 204);
};

export const unlike: RouteHandler<typeof unlikeRoute, AppEnv> = async (c) => {
  await service.unlikePhoto(c.env.DB, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};
