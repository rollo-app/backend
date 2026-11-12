import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { getConfigRoute } from "./config.router";
import * as service from "./config.service";

export const getConfig: RouteHandler<typeof getConfigRoute, AppEnv> = async (c) => c.json(await service.getPublicConfig(c.env), 200);
