import { rejectMomentFeaturing, rejectSelfieById } from "../moments/moments.service";
import { canSeeProfile } from "../users/users.service";
import { isRevealed } from "../../lib/util";
import { actorName, sendPush } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { MAX_FEATURED } from "./featured.schemas";
import * as repo from "./featured.repository";

/**
 * Where can a photo go? Whether `viewer` may feature a photo on their profile. The single place for the rule
 * (featuring, the revealed feed and the cleanups all agree with it). Four levels, the most restrictive wins:
 *  1. private rollo (`trips.featuring_disabled`): nobody, not even the author;
 *  2. the author can always feature their own photos;
 *  3. others need the photo (`media.feature_blocked_at`), the author's membership (`members.allow_featuring`)
 *     and the author's account (`user_settings.allow_featuring`) to allow it.
 * Turning a level off also deletes what it now blocks from other profiles (see `featured.repository`).
 */
export type FeaturingFacts = {
  viewerIsAuthor: boolean;
  /** The rollo is private. */
  rolloPrivate: boolean;
  /** The author blocked this one photo. */
  photoBlocked: boolean;
  /** The author lets others feature their photos of this rollo. */
  memberAllows: boolean;
  /** The author lets others feature any of their photos. */
  accountAllows: boolean;
};

export type FeaturingDenial = "private_rollo" | "author_declined" | null;

/** Why `viewer` can't feature the photo, or null if they can. */
export function featuringDenial(f: FeaturingFacts): FeaturingDenial {
  if (f.rolloPrivate) return "private_rollo";
  if (f.viewerIsAuthor) return null;
  if (f.photoBlocked || !f.memberAllows || !f.accountAllows) return "author_declined";
  return null;
}

export const canFeature = (f: FeaturingFacts): boolean => featuringDenial(f) === null;

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

function denialFor(row: repo.FeaturableMedia, viewerId: string) {
  return featuringDenial({
    viewerIsAuthor: row.author_user_id === viewerId,
    rolloPrivate: row.featuring_disabled !== 0,
    photoBlocked: row.feature_blocked_at !== null,
    memberAllows: row.member_allow_featuring !== 0,
    accountAllows: row.account_allow_featuring !== 0,
  });
}

function denialError(denial: NonNullable<ReturnType<typeof featuringDenial>>) {
  return denial === "private_rollo"
    ? conflict("Las fotos de este rollo no se pueden destacar")
    : conflict("Quien sacó esta foto no quiere que se destaque");
}

/** Features a photo. Returns the push to the author when it is a new feature of someone else's photo, else null. */
export async function featurePhoto(env: Env, user: UserRow, mediaId: string): Promise<AfterResponse> {
  const db = env.DB;
  const now = Date.now();
  const row = await repo.findFeaturableMedia(db, user.id, mediaId);
  if (!row) throw notFound();
  // An archived photo only exists for its author, who has to unarchive it first.
  if (row.archived_at !== null) {
    if (row.author_user_id !== user.id) throw notFound();
    throw conflict("Desarchivá esta foto para agregarla a tu perfil");
  }
  if (!isRevealed(row, now)) {
    throw conflict("Este rollo todavía no se reveló");
  }
  rejectMomentFeaturing(row);
  if (row.type !== "photo") throw badRequest("Solo se pueden destacar fotos");

  if (await repo.isFeatured(db, user.id, row.id)) return null;

  const denial = denialFor(row, user.id);
  if (denial) throw denialError(denial);

  const inserted = await repo.insertFeaturedUnderCap(db, user.id, row.id, now, MAX_FEATURED).run();
  if (!inserted.meta.changes) {
    if (await repo.isFeatured(db, user.id, row.id)) return null;
    // Not inserted: a level was turned off since the read above, or the cap. Read again to tell which.
    const again = await repo.findFeaturableMedia(db, user.id, mediaId);
    const nowDenied = again && denialFor(again, user.id);
    if (nowDenied) throw denialError(nowDenied);
    throw conflict(`Podés destacar hasta ${MAX_FEATURED} fotos`);
  }
  if (row.author_user_id === user.id) return null;
  const authorId = row.author_user_id;
  return () => sendPush(env, [authorId], "photoFeatured", { body: `${actorName(user)} destacó una foto tuya`, url: `/user/${user.id}` }, { actorId: user.id });
}

export async function unfeaturePhoto(db: D1Database, userId: string, mediaId: string): Promise<void> {
  await rejectSelfieById(db, mediaId);
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
