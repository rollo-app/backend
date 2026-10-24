import type { RouteHandler } from "@hono/zod-openapi";
import { serveMediaFile } from "../../lib/r2";
import { avatarUrl } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { FeedRow } from "./media.repository";
import type {
  blockFeatureRoute,
  completeRoute,
  deleteRoute,
  downloadRoute,
  feedRoute,
  registerRoute,
  unblockFeatureRoute,
} from "./media.router";
import * as service from "./media.service";

export const register: RouteHandler<typeof registerRoute, AppEnv> = async (c) => {
  const result = await service.registerMedia(c.env, new URL(c.req.url).origin, c.get("trip"), c.get("member"), c.req.valid("json"));
  if (result.created) return c.json(result.body, 201);
  return c.json(result.body, 200);
};

export const complete: RouteHandler<typeof completeRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  return c.json(await service.completeUpload(c.env, c.get("member"), mediaId), 200);
};

/** Feed item for the API. Before the reveal only metadata goes out; the rest is added after it. */
function presentFeedItem(r: FeedRow, tripId: string, revealed: boolean) {
  return {
    id: r.id,
    type: r.type,
    takenAt: r.taken_at,
    day: r.local_date,
    lat: r.lat,
    lng: r.lng,
    caption: r.caption,
    thumbhash: r.thumbhash,
    durationS: r.duration_s,
    author: {
      id: r.author_id,
      userId: r.author_user_id,
      name: r.author_name ?? "",
      username: r.author_username,
      avatarUrl: avatarUrl(r.author_user_id, r.author_avatar_key),
    },
    ...(revealed && {
      width: r.width,
      height: r.height,
      files: {
        thumb: `/trips/${tripId}/media/${r.id}/thumb`,
        original: `/trips/${tripId}/media/${r.id}/original`,
      },
      featuredByMe: r.featured_by_me === 1,
      featureBlocked: r.feature_blocked_at !== null,
      likeCount: r.like_count,
      likedByMe: r.liked_by_me === 1,
    }),
  };
}

export const feed: RouteHandler<typeof feedRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const { revealed, rows } = await service.getFeed(c.env.DB, trip, c.get("user").id);
  const items = rows.map((r) => presentFeedItem(r, trip.id, revealed));
  return c.json({ revealed, revealAt: trip.reveal_at, items }, 200);
};

export const download: RouteHandler<typeof downloadRoute, AppEnv> = async (c) => {
  const { mediaId, variant } = c.req.valid("param");
  const key = await service.getDownloadKey(c.env.DB, c.get("trip"), mediaId, variant);
  return serveMediaFile(c.env.MEDIA, key);
};

export const remove: RouteHandler<typeof deleteRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.deleteMediaFromTrip(c.env, c.get("trip"), mediaId);
  return c.body(null, 204);
};

export const blockFeature: RouteHandler<typeof blockFeatureRoute, AppEnv> = async (c) => {
  await service.blockFeature(c.env.DB, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};

export const unblockFeature: RouteHandler<typeof unblockFeatureRoute, AppEnv> = async (c) => {
  await service.unblockFeature(c.env.DB, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};
