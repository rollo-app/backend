import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { listAllMyMomentsRoute, listMyMomentsRoute } from "./moments.router";
import * as service from "./moments.service";

export const listMine: RouteHandler<typeof listMyMomentsRoute, AppEnv> = async (c) => {
  const moments = await service.getMyMoments(c.env.DB, c.get("trip"), c.get("user").id, Date.now());
  return c.json({ moments }, 200);
};

export const listAllMine: RouteHandler<typeof listAllMyMomentsRoute, AppEnv> = async (c) => {
  const trips = await service.getAllMyMoments(c.env.DB, c.get("user").id, Date.now());
  return c.json({ trips }, 200);
};
