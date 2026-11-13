import { conflict, badRequest, forbidden, notFound, rateLimited } from "../../shared/errors";
import { assertNotDegraded } from "../../lib/degraded";
import { assertStorageAvailable } from "../../lib/storage";
import { mediaKeys, presignPut } from "../../lib/r2";
import { resolveVariantKey, type MediaVariant } from "../../lib/media-variant";
import { isRevealed, localDate } from "../../lib/util";
import { MOMENT_WINDOW_MS } from "../../lib/moments";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { PAST_TOLERANCE_MS } from "../../schemas";
import { actorName, sendPush } from "../../lib/push";
import type { AfterResponse } from "../../shared/after-response";
import type { Env, MemberRow, TripRow, UserRow } from "../../types";
import { DEFAULT_FEED_PAGE, MAX_DISPLAY_SIZE, MAX_SIZE, MAX_THUMB_SIZE, type RegisterMediaInput } from "./media.schemas";
import { deleteFeaturedOfMedia } from "../featured/featured.repository";
import { deleteLikesOfMedia } from "../likes/likes.repository";
import { softDeleteCommentsOfMedia } from "../comments/comments.repository";
import { rejectSelfie, resolveMoment } from "../moments/moments.service";
import { recordMomentPhoto, recordMomentSelfie } from "../moments/moments.repository";
import * as repo from "./media.repository";
import * as tripsRepo from "../trips/trips.repository";

const UPLOAD_URL_TTL = 15 * 60;

type UploadResponse = { id: string; status: "pending"; upload: { original: string; thumb: string; display?: string }; expiresIn: number };

export type RegisterResult =
  | { created: true; body: UploadResponse }
  | { created: false; body: UploadResponse | { id: string; status: "uploaded" } };

async function uploadResponse(
  env: Env,
  origin: string,
  id: string,
  originalKey: string,
  thumbKey: string,
  sizes: { original: number | null; thumb: number | null },
  display: { key: string; size: number } | null = null,
) {
  const [original, thumb, displayUrl] = await Promise.all([
    presignPut(env, originalKey, origin, sizes.original),
    presignPut(env, thumbKey, origin, sizes.thumb),
    display ? presignPut(env, display.key, origin, display.size) : null,
  ]);
  // `display` only goes out when the phone declared one: older builds get the response they always got.
  return { id, status: "pending" as const, upload: { original, thumb, ...(displayUrl && { display: displayUrl }) }, expiresIn: UPLOAD_URL_TTL };
}

/**
 * The groups a new photo goes to. An organizer keeps the requested ids that are groups of the event, a guest the ones
 * they are in. Ids that no longer apply (the guest left the group, it was deleted) are dropped so a queued photo never
 * fails; if none is left, a guest's photo goes to all their groups and an organizer's to all the groups.
 */
export function resolveMediaGroups(args: {
  requested: string[];
  memberGroupIds: string[];
  allGroupIds: string[];
  isAdmin: boolean;
}): string[] {
  const allowed = new Set(args.isAdmin ? args.allGroupIds : args.memberGroupIds);
  const chosen = [...new Set(args.requested.filter((id) => allowed.has(id)))];
  if (chosen.length > 0) return chosen;
  return [...(args.isAdmin ? args.allGroupIds : args.memberGroupIds)];
}

/** Registers a photo or video and returns signed upload URLs. Idempotent by `input.id`; `created` tells a new row from a retry. */
export async function registerMedia(
  env: Env,
  origin: string,
  trip: TripRow,
  member: MemberRow,
  input: RegisterMediaInput,
): Promise<RegisterResult> {
  await assertNotDegraded(env);
  const now = Date.now();

  if (isRevealed(trip, now)) throw conflict("El rollo ya se reveló");
  if (input.takenAt > now + PAST_TOLERANCE_MS) throw badRequest("La hora de la foto está en el futuro");

  const existing = await repo.findMediaById(env.DB, input.id);
  if (existing) {
    if (existing.memberId !== member.id) throw conflict("Ese id ya existe");
    if (existing.deletedAt !== null) throw conflict("El admin borró esta foto");
    if (existing.status === "uploaded") return { created: false, body: { id: existing.id, status: "uploaded" as const } };
    return {
      created: false,
      body: await uploadResponse(
        env,
        origin,
        existing.id,
        existing.originalKey,
        existing.thumbKey,
        { original: existing.sizeBytes, thumb: existing.thumbSizeBytes },
        existing.displayKey && existing.displaySizeBytes !== null ? { key: existing.displayKey, size: existing.displaySizeBytes } : null,
      ),
    };
  }

  // Validated against when the photo was taken, not against the upload time: the offline queue
  // may register photos taken during the rollo after it ended (as long as it isn't revealed).
  // Placed after the existing-id branch so a retry is never newly rejected (e.g. if the admin edited the dates).
  if (input.takenAt < trip.starts_at - PAST_TOLERANCE_MS) {
    throw badRequest("Este rollo todavía no empezó");
  }
  if (input.takenAt > trip.ends_at + PAST_TOLERANCE_MS) {
    throw badRequest("Este rollo ya terminó");
  }

  const moment = await resolveMoment(env.DB, trip, member, input);

  await assertStorageAvailable(env, input.sizeBytes + input.thumbSizeBytes + (input.displaySizeBytes ?? 0));

  // Daily limit by the trip's local date. Also counts pending ones
  // (so you can't "reserve" more than allowed) and the ones deleted by the admin.
  // Moment photos and selfies are outside the quota.
  const day = localDate(input.takenAt, trip.timezone);
  if (moment) {
    // No quota.
  } else if (input.type === "video") {
    if (trip.daily_video_limit === 0) throw badRequest("Este rollo no admite videos");
    if ((await repo.countMemberMediaOnDay(env.DB, member.id, day, "video")) >= trip.daily_video_limit) {
      throw rateLimited(`Ya usaste tus ${trip.daily_video_limit} videos de hoy`);
    }
  } else if (trip.photo_limit_mode === "total") {
    // The whole rollo counts, not just the day.
    if ((await repo.countMemberMedia(env.DB, member.id, "photo")) >= (trip.total_photo_limit ?? 0)) {
      throw rateLimited("Ya usaste todas tus fotos del rollo");
    }
  } else if ((await repo.countMemberMediaOnDay(env.DB, member.id, day, "photo")) >= trip.daily_photo_limit) {
    throw rateLimited(`Ya usaste tus ${trip.daily_photo_limit} fotos de hoy`);
  }

  // Events only. The groups are fixed now (an organizer's "all groups" is the list at this moment, so a group
  // created later doesn't see the photo) and written in the same batch as the media row.
  let groupRows: ReturnType<typeof repo.insertMediaGroups> = [];
  if (trip.type === "event") {
    const groupIds = resolveMediaGroups({
      requested: input.groupIds ?? [],
      memberGroupIds: await tripsRepo.listMemberGroupIds(env.DB, member.id),
      allGroupIds: (await tripsRepo.listGroups(env.DB, trip.id)).map((g) => g.id),
      isAdmin: member.role === "admin",
    });
    // A guest in no group would store a photo nobody sees.
    if (groupIds.length === 0) throw conflict("Elegí un grupo para mandar fotos.");
    groupRows = repo.insertMediaGroups(env.DB, input.id, groupIds);
  }

  const keys = mediaKeys(trip.id, input.id, input.type);
  const insert = repo.insertMedia(env.DB, {
      id: input.id,
      tripId: trip.id,
      memberId: member.id,
      type: input.type,
      takenAt: input.takenAt,
      localDate: day,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accuracyM: input.accuracyM ?? null,
      caption: input.caption || null,
      thumbhash: input.thumbhash ?? null,
      durationS: input.durationS ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      sizeBytes: input.sizeBytes,
      thumbSizeBytes: input.thumbSizeBytes,
      originalKey: keys.original,
      thumbKey: keys.thumb,
      // Declared at registration (like the other sizes) so the cleanup crons and deletes know about the file;
      // only photos have one, and the retention cron treats a row as having a display once it is uploaded.
      displayKey: input.displaySizeBytes ? keys.display : null,
      displaySizeBytes: input.displaySizeBytes ?? null,
      createdAt: now,
      momentDay: moment?.day ?? null,
      pairedMediaId: moment?.pairedMediaId ?? null,
    });
  if (!moment) {
    await env.DB.batch([insert, ...groupRows]);
  } else {
    // The slot claim runs first and fails closed: if it didn't take (a concurrent request got there), the row
    // just inserted would be a photo outside every quota with no moment, so it is removed and the request is a 409.
    const claim = moment.pairedMediaId
      ? recordMomentSelfie(env.DB, trip.id, member.user_id, moment.day, input.id, moment.pairedMediaId)
      : recordMomentPhoto(
          env.DB,
          trip.id,
          member.user_id,
          moment.day,
          input.id,
          input.takenAt,
          input.takenAt >= moment.notifyAt && input.takenAt <= moment.notifyAt + MOMENT_WINDOW_MS,
        );
    const [claimed] = await env.DB.batch([claim, insert, ...groupRows]);
    if (claimed!.meta.changes === 0) {
      await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(input.id).run();
      throw conflict(moment.pairedMediaId ? "Este momento ya tiene selfie" : "Este momento ya tiene foto");
    }
  }

  return {
    created: true,
    body: await uploadResponse(
      env,
      origin,
      input.id,
      keys.original,
      keys.thumb,
      { original: input.sizeBytes, thumb: input.thumbSizeBytes },
      input.displaySizeBytes ? { key: keys.display, size: input.displaySizeBytes } : null,
    ),
  };
}

/** Verifies the files are in R2 with the registered sizes and marks the media as uploaded. */
export async function completeUpload(
  env: Env,
  trip: TripRow,
  member: MemberRow,
  user: Pick<UserRow, "id" | "name" | "username">,
  mediaId: string,
): Promise<{ body: { id: string; status: "uploaded" }; notify: AfterResponse }> {
  const row = await repo.findOwnLiveMedia(env.DB, mediaId, member.id);
  if (!row) throw notFound();
  const done = { id: row.id, status: "uploaded" as const };
  if (row.status === "uploaded") return { body: done, notify: null };

  const [original, thumb, display] = await Promise.all([
    env.MEDIA.head(row.originalKey),
    env.MEDIA.head(row.thumbKey),
    row.displayKey ? env.MEDIA.head(row.displayKey) : null,
  ]);
  // A declared display is as required as the other two files.
  if (!original || !thumb || (row.displayKey && !display)) {
    throw badRequest("Faltan archivos en el storage; volvé a subirlos");
  }
  const mismatch =
    original.size !== row.sizeBytes ||
    (row.thumbSizeBytes !== null && thumb.size !== row.thumbSizeBytes) ||
    original.size > MAX_SIZE[row.type] ||
    thumb.size > MAX_THUMB_SIZE ||
    (display !== null && (display.size !== row.displaySizeBytes || display.size > MAX_DISPLAY_SIZE));
  if (mismatch) {
    await env.MEDIA.delete([row.originalKey, row.thumbKey, ...(row.displayKey ? [row.displayKey] : [])]);
    throw badRequest("El archivo no coincide con el que registraste; volvé a subirlo");
  }

  const now = Date.now();
  const marked = await repo.markUploaded(env.DB, row.id, now, original.size).run();

  // "momentPosted": only the main photo of a moment (the linked image never notifies), only for the request that
  // actually flipped the row to uploaded (retries and concurrent completes lose the claim), never once revealed
  // (the reveal push covers it).
  const isMomentMain = row.momentDay !== null && row.pairedMediaId === null;
  if (!isMomentMain || marked.meta.changes === 0 || isRevealed(trip, now)) return { body: done, notify: null };
  return {
    body: done,
    notify: async () => {
      const recipients = await repo.listActiveMemberUserIds(env.DB, trip.id);
      await sendPush(
        env,
        recipients,
        "momentPosted",
        { title: `${actorName(user)} subió su momento`, body: trip.name, url: `/photo/${row.id}?tripId=${trip.id}` },
        { actorId: user.id },
      );
    },
  };
}

/** Feed rows of the trip for the viewer; `revealed` decides how much of each row the controller exposes. */
export async function getFeed(
  db: D1Database,
  trip: TripRow,
  viewerId: string,
  opts: { cursor?: string; limit?: number; order?: "asc" | "desc" } = {},
): Promise<{ revealed: boolean; rows: repo.FeedRow[]; nextCursor: string | null }> {
  const revealed = isRevealed(trip);
  const order = opts.order ?? "asc";
  // Older app builds send neither param and expect the whole feed.
  if (opts.cursor === undefined && opts.limit === undefined) {
    return { revealed, rows: await repo.listFeed(db, trip.id, viewerId, null, order), nextCursor: null };
  }
  const limit = opts.limit ?? DEFAULT_FEED_PAGE;
  const after = opts.cursor !== undefined ? decodeCursor(opts.cursor) : null;
  const fetched = await repo.listFeed(db, trip.id, viewerId, { limit: limit + 1, after: after && { takenAt: after.at, id: after.id } }, order);
  const rows = fetched.slice(0, limit);
  const last = rows[rows.length - 1];
  return { revealed, rows, nextCursor: fetched.length > limit && last ? encodeCursor({ at: last.takenAt, id: last.id }) : null };
}

/**
 * R2 key of the requested variant (and the one to try if its object is missing, see `resolveVariantKey`). Only after
 * the reveal, except for the two images of a daily moment, which any active member (the route already requires it)
 * can fetch as soon as they are uploaded.
 */
export async function getDownloadKey(
  db: D1Database,
  trip: TripRow,
  viewerId: string,
  mediaId: string,
  variant: MediaVariant,
): Promise<{ key: string; fallbackKey: string | null }> {
  const revealed = isRevealed(trip);
  const row = await repo.findDownloadKeys(db, mediaId, trip.id, viewerId);
  if (!revealed && !row?.isMoment) throw forbidden("Todavía no se reveló el rollo");
  if (!row) throw notFound();
  return resolveVariantKey(row, variant);
}

/**
 * Deletes a photo or video for everyone: removes its files and marks it deleted. The id cannot be registered again.
 * Returns false if it does not exist or was already deleted. With `purge` (the author deleting it after the reveal)
 * its likes, comments and featured rows go too, in the same batch.
 */
export async function deleteTripMedia(env: Env, mediaId: string, opts: { purge?: boolean } = {}): Promise<boolean> {
  const row = await repo.findLiveMediaById(env.DB, mediaId);
  if (!row) return false;
  // A moment's selfie goes with its main photo.
  const rows = [row, ...(await repo.findLiveSelfies(env.DB, row.id))];
  await env.MEDIA.delete(rows.flatMap((r) => [r.originalKey, r.thumbKey, ...(r.displayKey ? [r.displayKey] : [])]));
  const now = Date.now();
  await env.DB.batch(
    rows.flatMap((r) => [
      repo.markDeleted(env.DB, r.id, now),
      ...(opts.purge
        ? [deleteFeaturedOfMedia(env.DB, r.id), deleteLikesOfMedia(env.DB, r.id), softDeleteCommentsOfMedia(env.DB, r.id, now)]
        : []),
    ]),
  );
  return true;
}

/** Admin delete of a trip's media, before the reveal. */
export async function deleteMediaFromTrip(env: Env, trip: TripRow, mediaId: string): Promise<void> {
  if (isRevealed(trip)) throw conflict("El rollo ya se reveló");

  const inTrip = await repo.mediaExistsInTrip(env.DB, mediaId, trip.id);
  if (!inTrip || !(await deleteTripMedia(env, mediaId))) throw notFound();
}

/**
 * `DELETE /media/{id}`: before the reveal it is the admin's moderation delete (anyone else 403); after it, only the
 * author deletes their own photo or video for good. The admin keeps getting 409 on other people's photos once revealed.
 */
export async function deleteMedia(env: Env, trip: TripRow, member: MemberRow, mediaId: string): Promise<void> {
  if (!isRevealed(trip)) {
    if (member.role !== "admin") throw forbidden("Solo el admin del rollo puede hacer esto");
    return deleteMediaFromTrip(env, trip, mediaId);
  }
  const row = await repo.findLiveMediaById(env.DB, mediaId);
  if (row && row.tripId === trip.id && row.memberId !== member.id) {
    if (member.role === "admin") throw conflict("El rollo ya se reveló");
    throw forbidden(NOT_AUTHOR);
  }
  const own = await ownRevealedPhoto(env.DB, trip, member, mediaId);
  if (!(await deleteTripMedia(env, own.id, { purge: true }))) throw notFound();
}

const NOT_AUTHOR = "Solo quien sacó la foto puede hacer esto";

/**
 * The member's own uploaded photo or video of a revealed rollo: what archive, unarchive and the author's delete act on.
 * 404 if it doesn't exist (or is deleted, or of another rollo), 403 if someone else took it, 400 for a moment's linked
 * image (it follows its main photo), 409 before the reveal.
 */
async function ownRevealedPhoto(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string) {
  const row = await repo.findLiveMediaById(db, mediaId);
  if (!row || row.tripId !== trip.id || row.status !== "uploaded") throw notFound();
  if (row.memberId !== member.id) throw forbidden(NOT_AUTHOR);
  rejectSelfie(row.pairedMediaId);
  if (!isRevealed(trip)) throw conflict("Todavía no se reveló el rollo");
  return row;
}

/** Ids a change to `main` applies to: the photo and, for a daily moment, its linked image. */
async function withLinked(db: D1Database, mainId: string): Promise<string[]> {
  return [mainId, ...(await repo.findLiveSelfies(db, mainId)).map((r) => r.id)];
}

/**
 * The author hides their photo from everyone else, right away and without confirmation (it is reversible). It leaves
 * every profile where it was featured, the author's own included; unarchiving does not put it back. Idempotent.
 */
export async function archiveMedia(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string): Promise<void> {
  const row = await ownRevealedPhoto(db, trip, member, mediaId);
  const ids = await withLinked(db, row.id);
  await db.batch([repo.markArchived(db, ids, Date.now()), ...ids.map((id) => deleteFeaturedOfMedia(db, id))]);
}

export async function unarchiveMedia(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string): Promise<void> {
  const row = await ownRevealedPhoto(db, trip, member, mediaId);
  await repo.markUnarchived(db, await withLinked(db, row.id)).run();
}
