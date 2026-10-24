import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import type { getAvatarRoute } from "./avatars.router";
import * as service from "./avatars.service";

export const getAvatar: RouteHandler<typeof getAvatarRoute, AppEnv> = async (c) => {
  const { userId, file } = c.req.valid("param");
  const object = await service.getCurrentAvatar(c.env, userId, file);

  const headers = new Headers();
  headers.set("content-type", "image/jpeg");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("content-disposition", "inline");
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
};
