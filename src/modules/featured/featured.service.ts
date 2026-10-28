import { rejectMomentFeaturing, rejectSelfieById } from "../moments/moments.service";
import { canSeeProfile } from "../users/users.service";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { avatarUrl, isRevealed } from "../../lib/util";
import { actorName, sendPush } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { MAX_FEATURED } from "./featured.schemas";
import * as mediaRepo from "../media/media.repository";
import * as repo from "./featured.repository";

/**
 * Where can a photo go? Whether `viewer` may feature a photo on their profile. The single place for the rule
 * (featuring, the revealed feed and the cleanups all agree with it). Four levels, the most restrictive wins:
 *  1. private rollo (`trips.featuring_disabled`): nobody, not even the author;
 *  2. the author can always feature their own photos;
 *  3. a photo of someone else only if the author is a current friend of the viewer;
 *  4. and the photo (`media.feature_blocked_at`), the author's membership (`members.allow_featuring`)
 *     and the author's account (`user_settings.allow_featuring`) must all allow it.
 * Turning a level off, ending the friendship or blocking also deletes what it now blocks from the profiles (see `featured.repository`).
 */
export type FeaturingFacts = {
  viewerIsAuthor: boolean;
  /** The author is a current friend of the viewer. */
  authorIsFriend: boolean;
  /** The rollo is private. */
  rolloPrivate: boolean;
  /** The author blocked this one photo. */
  photoBlocked: boolean;
  /** The author lets others feature their photos of this rollo. */
  memberAllows: boolean;
  /** The author lets others feature any of their photos. */
  accountAllows: boolean;
};

export type FeaturingDenial = "private_rollo" | "not_friend" | "author_declined" | null;

/** Why `viewer` can't feature the photo, or null if they can. */
export function featuringDenial(f: FeaturingFacts): FeaturingDenial {
  if (f.rolloPrivate) return "private_rollo";
  if (f.viewerIsAuthor) return null;
  if (!f.authorIsFriend) return "not_friend";
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
    authorIsFriend: row.author_is_friend !== 0,
    rolloPrivate: row.featuring_disabled !== 0,
    photoBlocked: row.feature_blocked_at !== null,
    memberAllows: row.member_allow_featuring !== 0,
    accountAllows: row.account_allow_featuring !== 0,
  });
}

function denialError(denial: NonNullable<ReturnType<typeof featuringDenial>>) {
  if (denial === "private_rollo") return conflict("Las fotos de este rollo no se pueden destacar");
  if (denial === "not_friend") return conflict("Solo podés destacar fotos tuyas o de tus amigos");
  return conflict("Quien sacó esta foto no quiere que se destaque");
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

/**
 * The photo must be yours (you took it) and not deleted. Authorship is the media's member → user, so it holds
 * even after you left the rollo or were removed from it. 404 if it doesn't exist (or you aren't in its rollo
 * and didn't take it), 403 if an active member who didn't take it.
 */
export async function assertOwnMedia(db: D1Database, userId: string, mediaId: string): Promise<string> {
  const row = await mediaRepo.findAuthoredMedia(db, mediaId);
  if (!row) throw notFound();
  if (row.authorUserId === userId) return row.id;

  if (!(await mediaRepo.isActiveTripMember(db, row.tripId, userId))) throw notFound();
  throw forbidden("Solo quien sacó la foto puede cambiar esto");
}

/** Author-only: others can no longer feature the photo, and it leaves their profiles. Idempotent. */
export async function blockFeature(db: D1Database, userId: string, mediaId: string): Promise<void> {
  const id = await assertOwnMedia(db, userId, mediaId);
  await db.batch([mediaRepo.blockFeaturing(db, id, Date.now()), repo.deleteFeaturedByOthers(db, id, userId)]);
}

export async function unblockFeature(db: D1Database, userId: string, mediaId: string): Promise<void> {
  const id = await assertOwnMedia(db, userId, mediaId);
  await mediaRepo.unblockFeaturing(db, id).run();
}

export type FeaturedByItem = {
  mediaId: string;
  user: { id: string; name: string; username: string | null; avatarUrl: string | null; bio: string | null };
  featuredAt: number;
  thumbPath: string;
  thumbHash: string | null;
};

/**
 * "Destacaron tus fotos": the featurings of your photos by other users that you can see today, newest first
 * (filtered in SQL, see `repo.listFeaturedBy`). The cursor's id packs the photo and the profile owner (both uuids, so `.` is safe).
 */
export async function listFeaturedBy(
  db: D1Database,
  viewerId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ items: FeaturedByItem[]; nextCursor: string | null; total: number }> {
  const now = Date.now();
  let after: repo.FeaturedByCursor | null = null;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    const [mediaId, userId, ...rest] = c.id.split(".");
    if (!mediaId || !userId || rest.length > 0) throw badRequest("Cursor inválido");
    after = { featuredAt: c.at, mediaId, userId };
  }
  const [rows, total] = await Promise.all([repo.listFeaturedBy(db, viewerId, now, opts.limit + 1, after), repo.countFeaturedBy(db, viewerId, now)]);
  const page = rows.slice(0, opts.limit);
  const items = page.map(
    (r): FeaturedByItem => ({
      mediaId: r.media_id,
      user: { id: r.user_id, name: r.name ?? "", username: r.username, avatarUrl: avatarUrl(r.user_id, r.avatar_key), bio: r.bio },
      featuredAt: r.featured_at,
      thumbPath: `/featured/${r.user_id}/${r.media_id}/thumb`,
      thumbHash: r.thumbhash,
    }),
  );
  const last = page[page.length - 1];
  const nextCursor = rows.length > opts.limit && last ? encodeCursor({ at: last.featured_at, id: `${last.media_id}.${last.user_id}` }) : null;
  return { items, nextCursor, total };
}
