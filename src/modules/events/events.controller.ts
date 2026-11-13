import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { previewEventRoute } from "./events.router";
import * as service from "./events.service";

export const preview: RouteHandler<typeof previewEventRoute, AppEnv> = async (c) =>
  c.json(await service.previewEvent(c.env.DB, c.req.valid("param").code), 200);
