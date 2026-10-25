import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { createReportRoute } from "./reports.router";
import * as service from "./reports.service";

export const create: RouteHandler<typeof createReportRoute, AppEnv> = async (c) => {
  await service.createReport(c.get("deps"), c.get("user"), c.req.valid("json"), new URL(c.req.url).origin);
  return c.body(null, 204);
};
