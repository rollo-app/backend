import { conflict, badRequest, forbidden, notFound, rateLimited } from "../../shared/errors";
import { assertStorageAvailable } from "../../lib/storage";
import { mediaKeys } from "../../lib/media-files";
import { isRevealed, localDate } from "../../lib/util";
import { PAST_TOLERANCE_MS } from "../../schemas";
import type { Deps } from "../../container";
import type { ObjectStorage } from "../../ports/storage";
import type { MemberRow, TripRow } from "../../types";
import { MAX_SIZE, MAX_THUMB_SIZE, type RegisterMediaInput } from "./media.schemas";
import { deleteFeaturedByOthers } from "../featured/featured.repository";
import * as repo from "./media.repository";

const UPLOAD_URL_TTL = 15 * 60;

type UploadResponse = { id: string; status: "pending"; upload: { original: string; thumb: string }; expiresIn: number };

export type RegisterResult =
  | { created: true; body: UploadResponse }
  | { created: false; body: UploadResponse | { id: string; status: "uploaded" } };

async function uploadResponse(
  storage: ObjectStorage,
  origin: string,
  id: string,
  originalKey: string,
  thumbKey: string,
  sizes: { original: number | null; thumb: number | null },
) {
  const [original, thumb] = await Promise.all([
    storage.presignPut(originalKey, { origin, size: sizes.original, expiresIn: UPLOAD_URL_TTL }),
    storage.presignPut(thumbKey, { origin, size: sizes.thumb, expiresIn: UPLOAD_URL_TTL }),
  ]);
  return { id, status: "pending" as const, upload: { original, thumb }, expiresIn: UPLOAD_URL_TTL };
}

/** Registers a photo or video and returns signed upload URLs. Idempotent by `input.id`; `created` tells a new row from a retry. */
export async function registerMedia(
  deps: Pick<Deps, "db" | "storage" | "config">,
  origin: string,
  trip: TripRow,
  member: MemberRow,
  input: RegisterMediaInput,
): Promise<RegisterResult> {
  const now = Date.now();

  if (isRevealed(trip, now)) throw conflict("El rollo ya se reveló");
  if (input.takenAt > now + PAST_TOLERANCE_MS) throw badRequest("La hora de la foto está en el futuro");

  const existing = await repo.findMediaById(deps.db, input.id);
  if (existing) {
    if (existing.memberId !== member.id) throw conflict("Ese id ya existe");
    if (existing.deletedAt !== null) throw conflict("El admin borró esta foto");
    if (existing.status === "uploaded") return { created: false, body: { id: existing.id, status: "uploaded" as const } };
    return {
      created: false,
      body: await uploadResponse(deps.storage, origin, existing.id, existing.originalKey, existing.thumbKey, {
        original: existing.sizeBytes,
        thumb: existing.thumbSizeBytes,
      }),
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

  await assertStorageAvailable(deps, input.sizeBytes + input.thumbSizeBytes);

  // Daily limit by the trip's local date. Also counts pending ones
  // (so you can't "reserve" more than allowed) and the ones deleted by the admin.
  const day = localDate(input.takenAt, trip.timezone);
  const limit = input.type === "photo" ? trip.daily_photo_limit : trip.daily_video_limit;
  if ((await repo.countMemberMediaOnDay(deps.db, member.id, day, input.type)) >= limit) {
    const what = input.type === "photo" ? "fotos" : "videos";
    throw rateLimited(`Ya usaste tus ${limit} ${what} de hoy`);
  }

  const keys = mediaKeys(trip.id, input.id, input.type);
  await repo
    .insertMedia(deps.db, {
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
      createdAt: now,
    })
    .run();

  return {
    created: true,
    body: await uploadResponse(deps.storage, origin, input.id, keys.original, keys.thumb, { original: input.sizeBytes, thumb: input.thumbSizeBytes }),
  };
}

/** Verifies the files are in the storage with the registered sizes and marks the media as uploaded. */
export async function completeUpload(deps: Pick<Deps, "db" | "storage">, member: MemberRow, mediaId: string): Promise<{ id: string; status: "uploaded" }> {
  const row = await repo.findOwnLiveMedia(deps.db, mediaId, member.id);
  if (!row) throw notFound();
  if (row.status === "uploaded") return { id: row.id, status: "uploaded" };

  const [original, thumb] = await Promise.all([deps.storage.head(row.originalKey), deps.storage.head(row.thumbKey)]);
  if (!original || !thumb) {
    throw badRequest("Faltan archivos en el storage; volvé a subirlos");
  }
  const mismatch =
    original.size !== row.sizeBytes ||
    (row.thumbSizeBytes !== null && thumb.size !== row.thumbSizeBytes) ||
    original.size > MAX_SIZE[row.type] ||
    thumb.size > MAX_THUMB_SIZE;
  if (mismatch) {
    await deps.storage.delete([row.originalKey, row.thumbKey]);
    throw badRequest("El archivo no coincide con el que registraste; volvé a subirlo");
  }

  await repo.markUploaded(deps.db, row.id, Date.now(), original.size).run();
  return { id: row.id, status: "uploaded" };
}

/** Feed rows of the trip for the viewer; `revealed` decides how much of each row the controller exposes. */
export async function getFeed(db: D1Database, trip: TripRow, viewerId: string): Promise<{ revealed: boolean; rows: repo.FeedRow[] }> {
  const revealed = isRevealed(trip);
  return { revealed, rows: await repo.listFeed(db, trip.id, viewerId) };
}

/** R2 key of the requested variant; only after the reveal. */
export async function getDownloadKey(db: D1Database, trip: TripRow, mediaId: string, variant: "thumb" | "original"): Promise<string> {
  if (!isRevealed(trip)) throw forbidden("Todavía no se reveló el rollo");

  const row = await repo.findDownloadKeys(db, mediaId, trip.id);
  if (!row) throw notFound();
  return variant === "thumb" ? row.thumbKey : row.originalKey;
}

/**
 * Deletes a photo or video for everyone: removes its files and marks it deleted. The id cannot be registered again.
 * Returns false if it does not exist or was already deleted.
 */
export async function deleteTripMedia(deps: Pick<Deps, "db" | "storage">, mediaId: string): Promise<boolean> {
  const row = await repo.findLiveMediaById(deps.db, mediaId);
  if (!row) return false;
  await deps.storage.delete([row.originalKey, row.thumbKey]);
  await repo.markDeleted(deps.db, row.id, Date.now()).run();
  return true;
}

/** Admin delete of a trip's media, before the reveal. */
export async function deleteMediaFromTrip(deps: Pick<Deps, "db" | "storage">, trip: TripRow, mediaId: string): Promise<void> {
  if (isRevealed(trip)) throw conflict("El rollo ya se reveló");

  const inTrip = await repo.mediaExistsInTrip(deps.db, mediaId, trip.id);
  if (!inTrip || !(await deleteTripMedia(deps, mediaId))) throw notFound();
}

/**
 * The photo must be yours (you took it) and not deleted. Authorship is the media's member → user, so it holds
 * even after you left the rollo or were removed from it. 404 if it doesn't exist (or you aren't in its rollo
 * and didn't take it), 403 if an active member who didn't take it.
 */
export async function assertOwnMedia(db: D1Database, userId: string, mediaId: string): Promise<string> {
  const row = await repo.findAuthoredMedia(db, mediaId);
  if (!row) throw notFound();
  if (row.authorUserId === userId) return row.id;

  if (!(await repo.isActiveTripMember(db, row.tripId, userId))) throw notFound();
  throw forbidden("Solo quien sacó la foto puede cambiar esto");
}

/** Author-only: others can no longer feature the photo, and it leaves their profiles. Idempotent. */
export async function blockFeature(db: D1Database, userId: string, mediaId: string): Promise<void> {
  const id = await assertOwnMedia(db, userId, mediaId);
  await db.batch([repo.blockFeaturing(db, id, Date.now()), deleteFeaturedByOthers(db, id, userId)]);
}

export async function unblockFeature(db: D1Database, userId: string, mediaId: string): Promise<void> {
  const id = await assertOwnMedia(db, userId, mediaId);
  await repo.unblockFeaturing(db, id).run();
}
