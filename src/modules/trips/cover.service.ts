import { assertNotDegraded } from "../../lib/degraded";
import { hasJpegMagic } from "../../lib/jpeg";
import { presignPut } from "../../lib/r2";
import { assertStorageAvailable } from "../../lib/storage";
import { coverUrl } from "../../lib/util";
import { badRequest, conflict } from "../../shared/errors";
import type { Env, TripRow } from "../../types";
import * as repo from "./trips.repository";
import { COVER_MAX_BYTES } from "./trips.schemas";

const COVER_URL_TTL = 15 * 60;

const coverKey = (tripId: string) => `trips/${tripId}/cover/${crypto.randomUUID()}.jpg`;

function assertEvent(trip: TripRow): void {
  if (trip.type !== "event") throw conflict("Solo los eventos tienen portada.");
}

/** Same flow as the avatar: a presigned PUT to a pending key, then `completeCoverUpload` validates and promotes it. */
export async function requestCoverUpload(
  env: Env,
  origin: string,
  trip: TripRow,
  sizeBytes: number,
): Promise<{ upload: string; expiresIn: number }> {
  assertEvent(trip);
  await assertNotDegraded(env);
  await assertStorageAvailable(env, sizeBytes);
  // Don't leave the previous unconfirmed upload orphaned in R2.
  if (trip.pending_cover_key) await env.MEDIA.delete(trip.pending_cover_key);
  const key = coverKey(trip.id);
  await repo.setPendingCoverKey(env.DB, trip.id, key).run();
  const upload = await presignPut(env, key, origin, sizeBytes, COVER_URL_TTL);
  return { upload, expiresIn: COVER_URL_TTL };
}

/** Validates the uploaded cover, makes it the event's cover and deletes the previous one. */
export async function completeCoverUpload(env: Env, trip: TripRow): Promise<{ coverUrl: string }> {
  assertEvent(trip);
  const pending = trip.pending_cover_key;
  if (!pending) throw badRequest("Primero pedí dónde subir la foto");
  const object = await env.MEDIA.get(pending);
  if (!object) throw badRequest("Falta la foto; volvé a subirla");

  // Validate and copy the very same bytes: the presigned PUT stays valid after this call.
  const bytes = object.size > COVER_MAX_BYTES ? null : await object.arrayBuffer();
  if (!bytes || bytes.byteLength > COVER_MAX_BYTES || !hasJpegMagic(new Uint8Array(bytes))) {
    await env.MEDIA.delete(pending);
    await repo.clearPendingCoverKey(env.DB, trip.id).run();
    throw badRequest("La portada tiene que ser un JPEG de hasta 2 MB");
  }

  // Promote to a key that was never presigned, so nobody can overwrite it afterwards.
  const key = coverKey(trip.id);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.MEDIA.delete(pending);
  await repo.promoteCover(env.DB, trip.id, key).run();
  if (trip.cover_key) await env.MEDIA.delete(trip.cover_key);
  return { coverUrl: coverUrl({ id: trip.id, cover_key: key })! };
}
