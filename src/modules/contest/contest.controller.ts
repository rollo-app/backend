import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { addFinalistRoute, getContestRoute, removeFinalistRoute } from "./contest.router";
import * as service from "./contest.service";

export const get: RouteHandler<typeof getContestRoute, AppEnv> = async (c) => {
  return c.json(await service.getContest(c.env.DB, c.get("trip"), c.get("member"), c.get("user").id), 200);
};

export const add: RouteHandler<typeof addFinalistRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.addFinalist(c.env.DB, c.get("trip"), c.get("member"), mediaId);
  return c.body(null, 204);
};

export const remove: RouteHandler<typeof removeFinalistRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.removeFinalist(c.env.DB, c.get("trip"), c.get("member"), mediaId);
  return c.body(null, 204);
};
