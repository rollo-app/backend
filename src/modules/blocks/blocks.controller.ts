import type { RouteHandler } from "@hono/zod-openapi";
import { avatarUrl } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { blockRoute, listRoute, unblockRoute } from "./blocks.router";
import * as service from "./blocks.service";

export const list: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const rows = await service.listBlocked(c.get("deps").db, c.get("user").id);
  return c.json(
    {
      blocked: rows.map((u) => ({
        id: u.id,
        name: u.name ?? "",
        username: u.username,
        avatarUrl: avatarUrl(u.id, u.avatar_key),
        bio: u.bio,
      })),
    },
    200,
  );
};

export const block: RouteHandler<typeof blockRoute, AppEnv> = async (c) => {
  await service.blockUser(c.get("deps"), c.get("user"), c.req.valid("param").userId, new URL(c.req.url).origin);
  return c.body(null, 204);
};

export const unblock: RouteHandler<typeof unblockRoute, AppEnv> = async (c) => {
  await service.unblockUser(c.get("deps").db, c.get("user").id, c.req.valid("param").userId);
  return c.body(null, 204);
};
