import { isBlockedEitherWay } from "../../lib/moderation";
import { canSeeProfile } from "../../lib/profile-access";
import { isRevealed } from "../../lib/util";
import { badRequest, notFound } from "../../shared/errors";
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

/** Likes the photo. `notify` is true when the like is new and the author is someone else (the push is the controller's to send). */
export async function likePhoto(
  db: D1Database,
  viewerId: string,
  mediaId: string,
): Promise<{ photo: Likeable; now: number; notify: boolean }> {
  const now = Date.now();
  const photo = await likeablePhoto(db, viewerId, mediaId, now);
  const inserted = await repo.insertLike(db, viewerId, photo.id, now).run();
  return { photo, now, notify: inserted.meta.changes > 0 && photo.authorUserId !== viewerId };
}

export async function unlikePhoto(db: D1Database, viewerId: string, mediaId: string): Promise<void> {
  await repo.deleteLike(db, viewerId, mediaId).run();
}
