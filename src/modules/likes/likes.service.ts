import { isBlockedEitherWay } from "../blocks/blocks.service";
import { canSeeProfile } from "../users/users.service";
import { avatarUrl, isRevealed } from "../../lib/util";
import { rejectSelfie, rejectSelfieById } from "../moments/moments.service";
import { actorName, sendPush, type PushMessage } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import * as repo from "./likes.repository";

/** Likes ("me gusta") on photos: one counter per photo, whether the like came from its rollo or from a profile. */

export type Likeable = { id: string; tripId: string; authorUserId: string };

/**
 * The photo if `viewerId` can see it, which is who can like it: an active member of its rollo once revealed,
 * or anyone who can see (`canSeeProfile`) a profile where it currently shows as featured. A block with the author
 * (either way), a photo the viewer reported, or anything else → 404, without telling whether it exists.
 * A video an active member can see → 400.
 */
async function likeablePhoto(db: D1Database, viewerId: string, mediaId: string, now: number): Promise<Likeable> {
  const row = await repo.findLikeableRow(db, viewerId, mediaId);
  if (!row) throw notFound();
  if (row.author_user_id !== viewerId && (await isBlockedEitherWay(db, viewerId, row.author_user_id))) {
    throw notFound();
  }
  rejectSelfie(row.paired_media_id);
  const photo = { id: row.id, tripId: row.trip_id, authorUserId: row.author_user_id };

  if (row.is_member === 1 && isRevealed(row, now)) {
    if (row.type !== "photo") throw badRequest("Solo se pueden poner me gusta a fotos");
    return photo;
  }

  // Through a profile: the profiles where it shows as featured right now (only photos ever do).
  const owners = await repo.listFeaturedOwners(db, row.id, now);
  for (const owner of owners) {
    if (await canSeeProfile(db, viewerId, owner)) return photo;
  }
  throw notFound();
}

/** Likes the photo. `notify` is the push (with its anti-spam decision) when the like is new and the author is someone else, else null. */
export async function likePhoto(env: Env, viewer: Pick<UserRow, "id" | "name" | "username">, mediaId: string): Promise<{ notify: AfterResponse }> {
  const db = env.DB;
  const viewerId = viewer.id;
  const now = Date.now();
  const photo = await likeablePhoto(db, viewerId, mediaId, now);
  const inserted = await repo.insertLike(db, viewerId, photo.id, now).run();
  return { notify: inserted.meta.changes > 0 && photo.authorUserId !== viewerId ? () => notifyLike(env, viewer, photo, now) : null };
}

export async function unlikePhoto(db: D1Database, viewerId: string, mediaId: string): Promise<void> {
  await rejectSelfieById(db, mediaId);
  await repo.deleteLike(db, viewerId, mediaId).run();
}

export type LikedPhoto = {
  mediaId: string;
  likedAt: number;
  authorUserId: string;
  author: { id: string; name: string; username: string | null; avatarUrl: string | null };
  thumbPath: string;
  thumbHash: string | null;
  source: { kind: "trip"; tripId: string } | { kind: "featured"; userId: string };
};

function encodeCursor(c: repo.LikesCursor): string {
  return btoa(`${c.likedAt}:${c.mediaId}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): repo.LikesCursor {
  try {
    const [at, mediaId, ...rest] = atob(raw.replace(/-/g, "+").replace(/_/g, "/")).split(":");
    const likedAt = Number(at);
    if (rest.length === 0 && mediaId && Number.isSafeInteger(likedAt) && likedAt >= 0) return { likedAt, mediaId };
  } catch {
    // falls through
  }
  throw badRequest("Cursor inválido");
}

/**
 * The photos the viewer liked that they can open today, newest like first (filtered by the server, see
 * `repo.listVisibleLikes`). Each says where to open it: the rollo wins over a profile.
 */
export async function listMyLikes(
  db: D1Database,
  viewerId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ items: LikedPhoto[]; nextCursor: string | null; total: number }> {
  const now = Date.now();
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const [rows, total] = await Promise.all([
    repo.listVisibleLikes(db, viewerId, now, opts.limit + 1, after),
    repo.countVisibleLikes(db, viewerId, now),
  ]);
  const page = rows.slice(0, opts.limit);
  const items = page.map((r): LikedPhoto => {
    const viaTrip = r.via_trip === 1;
    return {
      mediaId: r.media_id,
      likedAt: r.liked_at,
      authorUserId: r.author_user_id,
      author: { id: r.author_user_id, name: r.author_name ?? "", username: r.author_username, avatarUrl: avatarUrl(r.author_user_id, r.author_avatar_key) },
      thumbPath: viaTrip ? `/trips/${r.trip_id}/media/${r.media_id}/thumb` : `/featured/${r.featured_owner_id}/${r.media_id}/thumb`,
      thumbHash: r.thumbhash,
      source: viaTrip ? { kind: "trip", tripId: r.trip_id } : { kind: "featured", userId: r.featured_owner_id! },
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > opts.limit && last ? encodeCursor({ likedAt: last.liked_at, mediaId: last.media_id }) : null, total };
}

/** After a "photoLiked" push, the next likes of that photo within this window are counted but not notified. */
export const LIKE_PUSH_WINDOW_MS = 30 * 60_000;

/** "A Cami le gustó tu foto" / "A Cami y 3 más les gustó tu foto". Opens the photo in its rollo's gallery. */
export function photoLikedMessage(
  liker: Pick<UserRow, "name" | "username">,
  silenced: number,
  photo: { id: string; tripId: string },
): PushMessage {
  const who = actorName(liker);
  return {
    body: silenced > 0 ? `A ${who} y ${silenced} más les gustó tu foto` : `A ${who} le gustó tu foto`,
    url: `/photo/${photo.id}?tripId=${photo.tripId}`,
  };
}

/**
 * Anti-spam for like pushes, decided per photo. Returns how many likes were silenced since the last push
 * if this like should notify now (and opens a new window), or null if it falls inside the window (it is counted).
 * The read and the conditional claim run in one batch (a transaction), so two concurrent likes can't both notify.
 * Unliking doesn't touch the counter: a silenced like that was later removed still counts in "y N más".
 */
async function claimLikePush(db: D1Database, mediaId: string, now: number): Promise<number | null> {
  const [before, claim] = await db.batch<{ silenced: number }>([
    repo.selectSilencedLikes(db, mediaId),
    repo.claimLikePushWindow(db, mediaId, now, now - LIKE_PUSH_WINDOW_MS),
  ]);
  if (claim!.meta.changes > 0) return before!.results[0]?.silenced ?? 0;
  await repo.countSilencedLike(db, mediaId).run();
  return null;
}

/** After a new like by someone other than the author: the anti-spam decision and, if it's time, the push. */
async function notifyLike(
  env: Pick<Env, "DB">,
  liker: Pick<UserRow, "id" | "name" | "username">,
  photo: { id: string; tripId: string; authorUserId: string },
  now: number,
): Promise<void> {
  const silenced = await claimLikePush(env.DB, photo.id, now);
  if (silenced === null) return;
  await sendPush(env, [photo.authorUserId], "photoLiked", photoLikedMessage(liker, silenced, photo), { actorId: liker.id });
}
