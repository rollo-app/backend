import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { featured, likes, media, members, users, type Media, type NewMedia } from "../../db/schema";
import { notHiddenFor } from "../../lib/moderation";
import { orm, toStatement } from "../../shared/db";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])` (see `toStatement`).

export type { Media, NewMedia };

export type FeedRow = {
  id: string;
  type: Media["type"];
  takenAt: number;
  localDate: string;
  lat: number | null;
  lng: number | null;
  caption: string | null;
  thumbhash: string | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  authorId: string;
  authorName: string | null;
  authorUsername: string | null;
  authorUserId: string;
  authorAvatarKey: string | null;
  featureBlockedAt: number | null;
  featuredByMe: boolean;
  likeCount: number;
  likedByMe: boolean;
};

export type AuthoredMedia = { id: string; tripId: string; authorUserId: string };

export async function findMediaById(db: D1Database, id: string): Promise<Media | null> {
  return (await orm(db).select().from(media).where(eq(media.id, id)).get()) ?? null;
}

/** Not deleted. */
export async function findLiveMediaById(db: D1Database, id: string): Promise<Media | null> {
  return (await orm(db).select().from(media).where(and(eq(media.id, id), isNull(media.deletedAt))).get()) ?? null;
}

/** The member's own media, not deleted. */
export async function findOwnLiveMedia(db: D1Database, id: string, memberId: string): Promise<Media | null> {
  const row = await orm(db)
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.memberId, memberId), isNull(media.deletedAt)))
    .get();
  return row ?? null;
}

export async function mediaExistsInTrip(db: D1Database, id: string, tripId: string): Promise<boolean> {
  const row = await orm(db).select({ id: media.id }).from(media).where(and(eq(media.id, id), eq(media.tripId, tripId))).get();
  return row !== undefined;
}

/** Pending ones count too, and so do the ones deleted by the admin. */
export async function countMemberMediaOnDay(db: D1Database, memberId: string, day: string, type: Media["type"]): Promise<number> {
  const row = await orm(db)
    .select({ n: count() })
    .from(media)
    .where(and(eq(media.memberId, memberId), eq(media.localDate, day), eq(media.type, type)))
    .get();
  return row?.n ?? 0;
}

export function insertMedia(db: D1Database, m: NewMedia): D1PreparedStatement {
  return toStatement(db, orm(db).insert(media).values(m));
}

export function markUploaded(db: D1Database, id: string, now: number, size: number): D1PreparedStatement {
  return toStatement(db, orm(db).update(media).set({ status: "uploaded", uploadedAt: now, sizeBytes: size }).where(eq(media.id, id)));
}

export function markDeleted(db: D1Database, id: string, now: number): D1PreparedStatement {
  return toStatement(db, orm(db).update(media).set({ deletedAt: now }).where(eq(media.id, id)));
}

export async function listFeed(db: D1Database, tripId: string, viewerId: string): Promise<FeedRow[]> {
  const viewerLike = alias(likes, "viewer_like");
  const countedLike = alias(likes, "counted_like");
  const countedMedia = alias(media, "counted_media");

  // Likes per photo of this trip, so the feed gets every count in one query.
  const likeCounts = orm(db)
    .select({ mediaId: countedLike.mediaId, n: count().as("n") })
    .from(countedLike)
    .innerJoin(countedMedia, eq(countedMedia.id, countedLike.mediaId))
    .where(eq(countedMedia.tripId, tripId))
    .groupBy(countedLike.mediaId)
    .as("like_counts");

  return orm(db)
    .select({
      id: media.id,
      type: media.type,
      takenAt: media.takenAt,
      localDate: media.localDate,
      lat: media.lat,
      lng: media.lng,
      caption: media.caption,
      thumbhash: media.thumbhash,
      durationS: media.durationS,
      width: media.width,
      height: media.height,
      authorId: members.id,
      authorName: users.name,
      authorUsername: users.username,
      authorUserId: members.userId,
      authorAvatarKey: users.avatarKey,
      featureBlockedAt: media.featureBlockedAt,
      featuredByMe: sql<boolean>`${featured.mediaId} IS NOT NULL`.mapWith(Boolean),
      likeCount: sql<number>`COALESCE(${likeCounts.n}, 0)`,
      likedByMe: sql<boolean>`${viewerLike.mediaId} IS NOT NULL`.mapWith(Boolean),
    })
    .from(media)
    .innerJoin(members, eq(members.id, media.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(featured, and(eq(featured.mediaId, media.id), eq(featured.userId, viewerId)))
    .leftJoin(viewerLike, and(eq(viewerLike.mediaId, media.id), eq(viewerLike.userId, viewerId)))
    .leftJoin(likeCounts, eq(likeCounts.mediaId, media.id))
    .where(
      and(
        eq(media.tripId, tripId),
        eq(media.status, "uploaded"),
        isNull(media.deletedAt),
        notHiddenFor(viewerId, media.id, members.userId),
      ),
    )
    .orderBy(asc(media.takenAt));
}

/** Keys of an uploaded, not deleted file of the trip. */
export async function findDownloadKeys(
  db: D1Database,
  id: string,
  tripId: string,
): Promise<Pick<Media, "originalKey" | "thumbKey"> | null> {
  const row = await orm(db)
    .select({ originalKey: media.originalKey, thumbKey: media.thumbKey })
    .from(media)
    .where(and(eq(media.id, id), eq(media.tripId, tripId), eq(media.status, "uploaded"), isNull(media.deletedAt)))
    .get();
  return row ?? null;
}

/** Not deleted media with its author's user id (media's member → user). */
export async function findAuthoredMedia(db: D1Database, id: string): Promise<AuthoredMedia | null> {
  const row = await orm(db)
    .select({ id: media.id, tripId: media.tripId, authorUserId: members.userId })
    .from(media)
    .innerJoin(members, eq(members.id, media.memberId))
    .where(and(eq(media.id, id), isNull(media.deletedAt)))
    .get();
  return row ?? null;
}

export async function isActiveTripMember(db: D1Database, tripId: string, userId: string): Promise<boolean> {
  const row = await orm(db)
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tripId, tripId), eq(members.userId, userId), isNull(members.removedAt), isNull(members.leftAt)))
    .get();
  return row !== undefined;
}

export function blockFeaturing(db: D1Database, id: string, now: number): D1PreparedStatement {
  return toStatement(
    db,
    orm(db).update(media).set({ featureBlockedAt: sql`COALESCE(${media.featureBlockedAt}, ${now})` }).where(eq(media.id, id)),
  );
}

export function unblockFeaturing(db: D1Database, id: string): D1PreparedStatement {
  return toStatement(db, orm(db).update(media).set({ featureBlockedAt: null }).where(eq(media.id, id)));
}
