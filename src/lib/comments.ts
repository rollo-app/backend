import { actorName, sendPush, type PushMessage } from "./push";
import type { Env, UserRow } from "../types";

/** After a "photoCommented" push, the next comments on that photo within this window are counted but not notified. */
export const COMMENT_PUSH_WINDOW_MS = 30 * 60_000;

type Photo = { id: string; tripId: string };

/** Opens the photo in its rollo's gallery with the comments sheet. */
const photoUrl = (photo: Photo) => `/photo/${photo.id}?tripId=${photo.tripId}&comments=1`;

/** "Cami comentó tu foto" / "Cami y 3 más comentaron tu foto". */
export function photoCommentedMessage(commenter: Pick<UserRow, "name" | "username">, silenced: number, photo: Photo): PushMessage {
  const who = actorName(commenter);
  return { body: silenced > 0 ? `${who} y ${silenced} más comentaron tu foto` : `${who} comentó tu foto`, url: photoUrl(photo) };
}

/** For those who commented before: "Cami también comentó una foto" / "Cami y 3 más también comentaron una foto". */
export function alsoCommentedMessage(commenter: Pick<UserRow, "name" | "username">, silenced: number, photo: Photo): PushMessage {
  const who = actorName(commenter);
  return {
    body: silenced > 0 ? `${who} y ${silenced} más también comentaron una foto` : `${who} también comentó una foto`,
    url: photoUrl(photo),
  };
}

/**
 * Anti-spam for comment pushes, decided per photo (same scheme as likes). Returns how many comments were silenced since the
 * last push if this comment should notify now (and opens a new window), or null if it falls inside the window (it is counted).
 * The read and the conditional claim run in one batch, so two concurrent comments can't both notify.
 */
export async function claimCommentPush(db: D1Database, mediaId: string, now: number): Promise<number | null> {
  const [before, claim] = await db.batch<{ silenced: number }>([
    db.prepare("SELECT comments_since_notified AS silenced FROM media WHERE id = ?").bind(mediaId),
    db
      .prepare(
        `UPDATE media SET comment_notified_at = ?, comments_since_notified = 0
         WHERE id = ? AND (comment_notified_at IS NULL OR comment_notified_at <= ?)`,
      )
      .bind(now, mediaId, now - COMMENT_PUSH_WINDOW_MS),
  ]);
  if (claim!.meta.changes > 0) return before!.results[0]?.silenced ?? 0;
  await db.prepare("UPDATE media SET comments_since_notified = comments_since_notified + 1 WHERE id = ?").bind(mediaId).run();
  return null;
}

/** Active members of the rollo (other than the photo's author) with a live comment on the photo. */
async function earlierCommenters(db: D1Database, photo: Photo & { authorUserId: string }): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.user_id FROM comments c
       JOIN members m ON m.trip_id = ? AND m.user_id = c.user_id AND m.removed_at IS NULL AND m.left_at IS NULL
       WHERE c.media_id = ? AND c.deleted_at IS NULL AND c.user_id <> ?`,
    )
    .bind(photo.tripId, photo.id, photo.authorUserId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** After a new comment: the anti-spam decision and, if it's time, the push to the author and to those who commented before. */
export async function notifyComment(
  env: Pick<Env, "DB">,
  commenter: Pick<UserRow, "id" | "name" | "username">,
  photo: Photo & { authorUserId: string },
  now: number,
): Promise<void> {
  const silenced = await claimCommentPush(env.DB, photo.id, now);
  if (silenced === null) return;
  const opts = { actorId: commenter.id };
  await sendPush(env, [photo.authorUserId], "photoCommented", photoCommentedMessage(commenter, silenced, photo), opts);
  const others = await earlierCommenters(env.DB, photo);
  if (others.length) await sendPush(env, others, "photoCommented", alsoCommentedMessage(commenter, silenced, photo), opts);
}
