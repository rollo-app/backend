import { notFound } from "../../shared/errors";
import type { Env } from "../../types";

/** The event's current cover object; anything else (older, guessed or missing) is a 404. */
export async function getCurrentCover(env: Env, tripId: string, file: string): Promise<R2ObjectBody> {
  const key = `trips/${tripId}/cover/${file}`;
  const row = await env.DB.prepare("SELECT cover_key FROM trips WHERE id = ?").bind(tripId).first<{ cover_key: string | null }>();
  if (!row || row.cover_key !== key) throw notFound();

  const object = await env.MEDIA.get(key);
  if (!object) throw notFound();
  return object;
}
