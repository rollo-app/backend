import { actorName, sendPush, type PushMessage } from "./push";
import type { Env, UserRow } from "../types";

/** After a "photoLiked" push, the next likes of that photo within this window are counted but not notified. */
export const LIKE_PUSH_WINDOW_MS = 30 * 60_000;

/** "A Cami le gustó tu foto" / "A Cami y 3 más les gustó tu foto". Opens the photo in its rollo's gallery. */
export function photoLikedMessage(
  liker: Pick<UserRow, "name" | "username">,
  silenced: number,
  photo: { id: string; tripId: string },
): PushMessage {
  const who = actorName(liker);
  return {
    body: silenced > 0 ? `A ${who} y ${silenced} más les gustó tu foto` : `A ${who} le gustó tu foto`,
    url: `/photo/${photo.id}?tripId=${photo.tripId}`,
  };
}

/**
 * Anti-spam for like pushes, decided per photo. Returns how many likes were silenced since the last push
 * if this like should notify now (and opens a new window), or null if it falls inside the window (it is counted).
 * The read and the conditional claim run in one batch (a transaction), so two concurrent likes can't both notify.
 * Unliking doesn't touch the counter: a silenced like that was later removed still counts in "y N más".
 */
export async function claimLikePush(db: D1Database, mediaId: string, now: number): Promise<number | null> {
  const [before, claim] = await db.batch<{ silenced: number }>([
    db.prepare("SELECT likes_since_notified AS silenced FROM media WHERE id = ?").bind(mediaId),
    db
      .prepare(
        `UPDATE media SET like_notified_at = ?, likes_since_notified = 0
         WHERE id = ? AND (like_notified_at IS NULL OR like_notified_at <= ?)`,
      )
      .bind(now, mediaId, now - LIKE_PUSH_WINDOW_MS),
  ]);
  if (claim!.meta.changes > 0) return before!.results[0]?.silenced ?? 0;
  await db.prepare("UPDATE media SET likes_since_notified = likes_since_notified + 1 WHERE id = ?").bind(mediaId).run();
  return null;
}

/** After a new like by someone other than the author: the anti-spam decision and, if it's time, the push. */
export async function notifyLike(
  env: Pick<Env, "DB">,
  liker: Pick<UserRow, "id" | "name" | "username">,
  photo: { id: string; tripId: string; authorUserId: string },
  now: number,
): Promise<void> {
  const silenced = await claimLikePush(env.DB, photo.id, now);
  if (silenced === null) return;
  await sendPush(env, [photo.authorUserId], "photoLiked", photoLikedMessage(liker, silenced, photo), { actorId: liker.id });
}
