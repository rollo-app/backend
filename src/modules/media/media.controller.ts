import { canFeature } from "../../lib/featuring";
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
function presentFeedItem(r: FeedRow, tripId: string, revealed: boolean, rolloPrivate: boolean, viewerId: string) {
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
    ...(r.momentDay !== null && {
      momentDay: r.momentDay,
      selfie:
        r.selfieId === null
          ? null
          : {
              id: r.selfieId,
              width: revealed ? r.selfieWidth : null,
              height: revealed ? r.selfieHeight : null,
              thumbhash: r.selfieThumbhash,
              files: revealed
                ? {
                    thumb: `/trips/${tripId}/media/${r.selfieId}/thumb`,
                    original: `/trips/${tripId}/media/${r.selfieId}/original`,
                  }
                : null,
            },
    }),
    ...(revealed && {
      width: r.width,
      height: r.height,
      files: {
        thumb: `/trips/${tripId}/media/${r.id}/thumb`,
        original: `/trips/${tripId}/media/${r.id}/original`,
      },
      featuredByMe: r.featuredByMe,
      featureBlocked: r.featureBlockedAt !== null,
      // The two images of a daily moment never go to a profile.
      canFeature: r.momentDay === null && canFeature({
        viewerIsAuthor: r.authorUserId === viewerId,
        rolloPrivate,
        photoBlocked: r.featureBlockedAt !== null,
        memberAllows: r.memberAllowsFeaturing,
        accountAllows: r.accountAllowsFeaturing,
      }),
      likeCount: r.likeCount,
      likedByMe: r.likedByMe,
      commentCount: r.commentCount,
    }),
  };
}

export const feed: RouteHandler<typeof feedRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const { revealed, rows } = await service.getFeed(c.env.DB, trip, c.get("user").id);
  const items = rows.map((r) => presentFeedItem(r, trip.id, revealed, trip.featuring_disabled !== 0, c.get("user").id));
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
