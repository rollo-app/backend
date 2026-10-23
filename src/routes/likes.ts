import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { notifyLike } from "../lib/likes";
import { hiddenMediaSql, isBlockedEitherWay } from "../lib/moderation";
import { bearerAuth, createApp, errors } from "../lib/openapi";
import { canSeeProfile } from "../lib/profile-access";
import { deferPush } from "../lib/push";
import { isRevealed } from "../lib/util";
import { MediaParams } from "../schemas";
import type { MediaRow, TripRow, UserRow } from "../types";
import { VISIBLE_FROM, VISIBLE_WHERE } from "./featured";

/** Likes ("me gusta") on photos: one counter per photo, whether the like came from its rollo or from a profile. */
const likes = createApp();
const tags = ["Likes"];

const NOT_FOUND = "No encontrado";

type Likeable = { id: string; tripId: string; authorUserId: string };

/**
 * The photo if `viewerId` can see it, which is who can like it: an active member of its rollo once revealed,
 * or anyone who can see (`canSeeProfile`) a profile where it currently shows as featured. A block with the author
 * (either way), a photo the viewer reported, or anything else → 404, without telling whether it exists.
 * A video an active member can see → 400.
 */
async function likeablePhoto(db: D1Database, viewerId: string, mediaId: string, now: number): Promise<Likeable> {
  const row = await db
    .prepare(
      `SELECT m.id, m.type, m.trip_id, author.user_id AS author_user_id, t.revealed_at, t.reveal_at,
              EXISTS (SELECT 1 FROM members me WHERE me.trip_id = m.trip_id AND me.user_id = ?
                        AND me.removed_at IS NULL AND me.left_at IS NULL) AS is_member
       FROM media m JOIN trips t ON t.id = m.trip_id JOIN members author ON author.id = m.member_id
       WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "author")}`,
    )
    .bind(viewerId, mediaId, viewerId, viewerId)
    .first<Pick<MediaRow, "id" | "type" | "trip_id"> & Pick<TripRow, "revealed_at" | "reveal_at"> & { author_user_id: string; is_member: number }>();
  if (!row) throw new HTTPException(404, { message: NOT_FOUND });
  if (row.author_user_id !== viewerId && (await isBlockedEitherWay(db, viewerId, row.author_user_id))) {
    throw new HTTPException(404, { message: NOT_FOUND });
  }
  const photo = { id: row.id, tripId: row.trip_id, authorUserId: row.author_user_id };

  if (row.is_member === 1 && isRevealed(row, now)) {
    if (row.type !== "photo") throw new HTTPException(400, { message: "Solo se pueden poner me gusta a fotos" });
    return photo;
  }

  // Through a profile: the profiles where it shows as featured right now (only photos ever do).
  const { results: owners } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.profile_visibility FROM ${VISIBLE_FROM} JOIN users u ON u.id = f.user_id
       WHERE ${VISIBLE_WHERE} AND f.media_id = ?`,
    )
    .bind(now, row.id)
    .all<Pick<UserRow, "id" | "profile_visibility">>();
  for (const owner of owners) {
    if (await canSeeProfile(db, viewerId, owner)) return photo;
  }
  throw new HTTPException(404, { message: NOT_FOUND });
}

const likeRoute = createRoute({
  method: "put",
  path: "/media/{mediaId}/like",
  tags,
  summary: "Like a photo",
  description:
    "Idempotent. Whoever can see the photo can like it: an active member of its rollo once it is revealed, or anyone who can " +
    "see a profile where it is featured. Otherwise 404 (also with a block with its author); 400 for a video. " +
    "Notifies the author (`photoLiked`) at most once every 30 minutes per photo: the likes in between are counted and added " +
    "to the next push (\"A Cami y 3 más les gustó tu foto\").",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Liked" }, ...errors(400, 401, 404) },
});

likes.openapi(likeRoute, async (c) => {
  const user = c.get("user");
  const { DB } = c.env;
  const now = Date.now();
  const photo = await likeablePhoto(DB, user.id, c.req.valid("param").mediaId, now);

  const inserted = await DB.prepare("INSERT OR IGNORE INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)")
    .bind(user.id, photo.id, now)
    .run();
  if (inserted.meta.changes > 0 && photo.authorUserId !== user.id) {
    deferPush(c, notifyLike(c.env, user, photo, now));
  }
  return c.body(null, 204);
});

const unlikeRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}/like",
  tags,
  summary: "Remove your like from a photo",
  description: "Idempotent: 204 also if you did not like it (or the photo does not exist). Never notifies.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Not liked anymore" }, ...errors(401) },
});

likes.openapi(unlikeRoute, async (c) => {
  await c.env.DB.prepare("DELETE FROM likes WHERE user_id = ? AND media_id = ?")
    .bind(c.get("user").id, c.req.valid("param").mediaId)
    .run();
  return c.body(null, 204);
});

export default likes;
