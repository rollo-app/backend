import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { listMyMomentsRoute } from "./moments.router";
import * as service from "./moments.service";

export const listMine: RouteHandler<typeof listMyMomentsRoute, AppEnv> = async (c) => {
  const moments = await service.getMyMoments(c.env.DB, c.get("trip"), c.get("user").id, Date.now());
  return c.json({ moments }, 200);
};
