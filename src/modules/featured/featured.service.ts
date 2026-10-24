import { canSeeProfile } from "../../lib/profile-access";
import { isRevealed } from "../../lib/util";
import { actorName, sendPush } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { MAX_FEATURED } from "./featured.schemas";
import * as repo from "./featured.repository";

/**
 * Featured photos: photos from revealed rollos that a user pins to their profile.
 * What leaves this module never includes the rollo, the caption or the exact location (only a ~5 km zone).
 */

const PRIVATE_PROFILE = "Este perfil es privado";

/** The profile owner, or 404 if they don't exist / 403 if the viewer can't see their profile. */
async function visibleOwner(db: D1Database, viewerId: string, userId: string) {
  const owner = await repo.findProfileOwner(db, userId);
  if (!owner) throw notFound("No existe");
  if (!(await canSeeProfile(db, viewerId, owner))) throw forbidden(PRIVATE_PROFILE);
  return owner;
}

/** Features a photo. Returns the push to the author when it is a new feature of someone else's photo, else null. */
export async function featurePhoto(env: Env, user: UserRow, mediaId: string): Promise<AfterResponse> {
  const db = env.DB;
  const now = Date.now();
  const row = await repo.findFeaturableMedia(db, user.id, mediaId);
  if (!row) throw notFound();
  if (!isRevealed(row, now)) {
    throw conflict("Este rollo todavía no se reveló");
  }
  if (row.type !== "photo") throw badRequest("Solo se pueden destacar fotos");

  if (await repo.isFeatured(db, user.id, row.id)) return null;

  if (row.feature_blocked_at !== null && row.author_user_id !== user.id) {
    throw conflict("Quien sacó esta foto no quiere que se destaque");
  }

  const inserted = await repo.insertFeaturedUnderCap(db, user.id, row.id, now, MAX_FEATURED).run();
  if (!inserted.meta.changes) {
    if (!(await repo.isFeatured(db, user.id, row.id))) throw conflict(`Podés destacar hasta ${MAX_FEATURED} fotos`);
    return null;
  }
  if (row.author_user_id === user.id) return null;
  const authorId = row.author_user_id;
  return () => sendPush(env, [authorId], "photoFeatured", { body: `${actorName(user)} destacó una foto tuya`, url: `/user/${user.id}` }, { actorId: user.id });
}

export async function unfeaturePhoto(db: D1Database, userId: string, mediaId: string): Promise<void> {
  await repo.deleteFeatured(db, userId, mediaId).run();
}

export async function listFeatured(
  db: D1Database,
  viewerId: string,
  userId: string,
): Promise<{ ownerId: string; rows: repo.FeaturedPhotoRow[] }> {
  const owner = await visibleOwner(db, viewerId, userId);
  const rows = await repo.listVisibleFeatured(db, viewerId, owner.id, Date.now());
  return { ownerId: owner.id, rows };
}

/** R2 key of a featured file, under the profile's permission (not the rollo's). */
export async function getFeaturedFileKey(
  db: D1Database,
  viewerId: string,
  userId: string,
  mediaId: string,
  variant: "thumb" | "original",
): Promise<string> {
  const owner = await visibleOwner(db, viewerId, userId);
  const row = await repo.findVisibleFeaturedKeys(db, viewerId, owner.id, mediaId, Date.now());
  if (!row) throw notFound();
  return variant === "thumb" ? row.thumb_key : row.original_key;
}
