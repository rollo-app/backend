import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { checkRoute } from "./usernames.router";
import * as service from "./usernames.service";

export const check: RouteHandler<typeof checkRoute, AppEnv> = async (c) =>
  c.json(await service.checkAvailability(c.get("deps").db, c.get("user").id, c.req.valid("param").username), 200);
