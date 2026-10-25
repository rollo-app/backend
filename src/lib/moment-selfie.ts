import { badRequest } from "../shared/errors";

/** Selfies of a moment (`media.paired_media_id`) travel inside their main photo: no likes, comments or featuring of their own. */
export function rejectSelfie(pairedMediaId: string | null): void {
  if (pairedMediaId !== null) throw badRequest("Esta foto no se puede usar así: es la selfie de un momento");
}

/** For the endpoints that have no lookup of their own (unlike, unfeature). */
export async function rejectSelfieById(db: D1Database, mediaId: string): Promise<void> {
  const row = await db.prepare("SELECT paired_media_id FROM media WHERE id = ?").bind(mediaId).first<{ paired_media_id: string | null }>();
  rejectSelfie(row?.paired_media_id ?? null);
}
