import { rejectSelfie } from "../../lib/moment-selfie";
import { notifyComment } from "../../lib/comments";
import { isBlockedEitherWay } from "../../lib/moderation";
import { avatarUrl, isRevealed } from "../../lib/util";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, forbidden, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import * as repo from "./comments.repository";

/**
 * Comments on revealed photos. Only active members of the photo's rollo can read or write them: unlike likes there is no
 * path through a profile, because a comment shows names and conversations of the rollo to people who are not in it.
 */

/** The most comments one photo returns. A rollo is a group of friends: this is a safety net, not a page size. */
const LIST_LIMIT = 500;

type Photo = { id: string; tripId: string; authorUserId: string; type: "photo" | "video"; archived: boolean };

/**
 * The photo if the viewer can comment on it: an active member of its rollo once revealed, the photo not hidden for them
 * (reported, or its author blocked) and no block with its author in either direction. Anything else → 404, without
 * telling whether it exists.
 */
async function visiblePhoto(db: D1Database, viewerId: string, mediaId: string, now: number): Promise<Photo> {
  const row = await repo.findCommentableRow(db, viewerId, mediaId);
  if (!row || row.is_member !== 1 || !isRevealed(row, now)) throw notFound();
  if (row.author_user_id !== viewerId && (await isBlockedEitherWay(db, viewerId, row.author_user_id))) throw notFound();
  rejectSelfie(row.paired_media_id);
  return { id: row.id, tripId: row.trip_id, authorUserId: row.author_user_id, type: row.type, archived: row.archived_at !== null };
}

function present(row: repo.CommentRow, viewerId: string, photoAuthorId: string) {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    author: { userId: row.user_id, name: row.name ?? "", username: row.username, avatarUrl: avatarUrl(row.user_id, row.avatar_key) },
    canDelete: row.user_id === viewerId || photoAuthorId === viewerId,
  };
}

export async function listComments(db: D1Database, viewerId: string, mediaId: string) {
  const photo = await visiblePhoto(db, viewerId, mediaId, Date.now());
  // A video can't have comments: its list is empty rather than an error, so the app can ask without checking the type.
  if (photo.type !== "photo") return [];
  return (await repo.listComments(db, viewerId, photo.id, LIST_LIMIT)).map((r) => present(r, viewerId, photo.authorUserId));
}

/** `notify` is the push (with its anti-spam decision), or null if there is nobody to tell. */
export async function createComment(env: Env, viewer: UserRow, mediaId: string, text: string): Promise<{ comment: ReturnType<typeof present>; notify: AfterResponse }> {
  const db = env.DB;
  const now = Date.now();
  const photo = await visiblePhoto(db, viewer.id, mediaId, now);
  if (photo.type !== "photo") throw badRequest("Solo se pueden comentar fotos");

  const id = crypto.randomUUID();
  await repo.insertComment(db, { id, mediaId: photo.id, userId: viewer.id, text, createdAt: now }).run();
  const comment = present(
    { id, text, created_at: now, user_id: viewer.id, name: viewer.name, username: viewer.username, avatar_key: viewer.avatar_key },
    viewer.id,
    photo.authorUserId,
  );
  // An archived photo only reaches its author (the only one who can comment on it now): nobody else is told.
  return { comment, notify: photo.archived ? null : () => notifyComment(env, viewer, photo, now) };
}

/** The author of the comment or the author of its photo deletes it (soft). Another member → 403; anyone who can't see it → 404. */
export async function deleteComment(db: D1Database, viewerId: string, commentId: string): Promise<void> {
  const comment = await repo.findComment(db, commentId);
  if (!comment) throw notFound();
  const photo = await visiblePhoto(db, viewerId, comment.media_id, Date.now());
  if (comment.user_id !== viewerId && photo.authorUserId !== viewerId) throw forbidden("No podés borrar este comentario");
  await repo.softDeleteComment(db, commentId, Date.now()).run();
}
