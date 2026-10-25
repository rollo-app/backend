import type { RouteHandler } from "@hono/zod-openapi";
import { serveMediaFile } from "../../lib/media-files";
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
  const result = await service.registerMedia(c.get("deps"), new URL(c.req.url).origin, c.get("trip"), c.get("member"), c.req.valid("json"));
  if (result.created) return c.json(result.body, 201);
  return c.json(result.body, 200);
};

export const complete: RouteHandler<typeof completeRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  return c.json(await service.completeUpload(c.get("deps"), c.get("member"), mediaId), 200);
};

/** Feed item for the API. Before the reveal only metadata goes out; the rest is added after it. */
function presentFeedItem(r: FeedRow, tripId: string, revealed: boolean) {
  return {
    id: r.id,
    type: r.type,
    takenAt: r.takenAt,
    day: r.localDate,
    lat: r.lat,
    lng: r.lng,
    caption: r.caption,
    thumbhash: r.thumbhash,
    durationS: r.durationS,
    author: {
      id: r.authorId,
      userId: r.authorUserId,
      name: r.authorName ?? "",
      username: r.authorUsername,
      avatarUrl: avatarUrl(r.authorUserId, r.authorAvatarKey),
    },
    ...(revealed && {
      width: r.width,
      height: r.height,
      files: {
        thumb: `/trips/${tripId}/media/${r.id}/thumb`,
        original: `/trips/${tripId}/media/${r.id}/original`,
      },
      featuredByMe: r.featuredByMe,
      featureBlocked: r.featureBlockedAt !== null,
      likeCount: r.likeCount,
      likedByMe: r.likedByMe,
    }),
  };
}

export const feed: RouteHandler<typeof feedRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const { revealed, rows } = await service.getFeed(c.get("deps").db, trip, c.get("user").id);
  const items = rows.map((r) => presentFeedItem(r, trip.id, revealed));
  return c.json({ revealed, revealAt: trip.reveal_at, items }, 200);
};

export const download: RouteHandler<typeof downloadRoute, AppEnv> = async (c) => {
  const { mediaId, variant } = c.req.valid("param");
  const key = await service.getDownloadKey(c.get("deps").db, c.get("trip"), mediaId, variant);
  return serveMediaFile(c.get("deps").storage, key);
};

export const remove: RouteHandler<typeof deleteRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.deleteMediaFromTrip(c.get("deps"), c.get("trip"), mediaId);
  return c.body(null, 204);
};

export const blockFeature: RouteHandler<typeof blockFeatureRoute, AppEnv> = async (c) => {
  await service.blockFeature(c.get("deps").db, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};

export const unblockFeature: RouteHandler<typeof unblockFeatureRoute, AppEnv> = async (c) => {
  await service.unblockFeature(c.get("deps").db, c.get("user").id, c.req.valid("param").mediaId);
  return c.body(null, 204);
};
