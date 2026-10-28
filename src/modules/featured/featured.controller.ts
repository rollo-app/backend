import type { RouteHandler } from "@hono/zod-openapi";
import { deferPush } from "../../lib/push";
import { serveStrippedJpeg } from "../../lib/r2";
import { avatarUrl } from "../../lib/util";
import { zoneOf } from "../../lib/zone";
import type { AppEnv } from "../../types";
import type { FeaturedPhotoRow } from "./featured.repository";
import type { featuredByRoute, featureRoute, fileRoute, listRoute, unfeatureRoute } from "./featured.router";
import { DEFAULT_FEATURED_BY_PAGE } from "./featured.schemas";
import * as service from "./featured.service";

export const feature: RouteHandler<typeof featureRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const { mediaId } = c.req.valid("param");
  const notify = await service.featurePhoto(c.env, user, mediaId);
  if (notify) deferPush(c, notify());
  return c.body(null, 204);
};

export const unfeature: RouteHandler<typeof unfeatureRoute, AppEnv> = async (c) => {
  await service.unfeaturePhoto(c.env.DB, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};

function presentPhoto(r: FeaturedPhotoRow, ownerId: string) {
  return {
    mediaId: r.id,
    takenAt: r.taken_at,
    width: r.width,
    height: r.height,
    thumbhash: r.thumbhash,
    author:
      r.author_user_id === ownerId
        ? null
        : {
            id: r.author_user_id,
            name: r.author_name ?? "",
            username: r.author_username,
            avatarUrl: avatarUrl(r.author_user_id, r.author_avatar_key),
          },
    zone: zoneOf(r.lat, r.lng),
    thumbPath: `/featured/${ownerId}/${r.id}/thumb`,
    originalPath: `/featured/${ownerId}/${r.id}/original`,
    likeCount: r.like_count,
    likedByMe: r.liked_by_me === 1,
  };
}

export const list: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const { ownerId, rows } = await service.listFeatured(c.env.DB, c.get("user").id, c.req.valid("param").userId);
  return c.json({ photos: rows.map((r) => presentPhoto(r, ownerId)) }, 200);
};

export const file: RouteHandler<typeof fileRoute, AppEnv> = async (c) => {
  const { userId, mediaId, variant } = c.req.valid("param");
  const key = await service.getFeaturedFileKey(c.env.DB, c.get("user").id, userId, mediaId, variant);
  return serveStrippedJpeg(c.env.MEDIA, key);
};

export const featuredBy: RouteHandler<typeof featuredByRoute, AppEnv> = async (c) => {
  const { cursor, limit } = c.req.valid("query");
  return c.json(await service.listFeaturedBy(c.env.DB, c.get("user").id, { cursor, limit: limit ?? DEFAULT_FEATURED_BY_PAGE }), 200);
};
