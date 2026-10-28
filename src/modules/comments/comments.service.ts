import { rejectSelfie } from "../moments/moments.service";
import { actorName, sendPush, type PushMessage } from "../../lib/push";
import { isBlockedEitherWay } from "../blocks/blocks.service";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { avatarUrl, isRevealed } from "../../lib/util";
import type { AfterResponse } from "../../shared/after-response";
import { badRequest, forbidden, notFound } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import * as repo from "./comments.repository";

/**
 * Comments on revealed photos and on daily moments (before the reveal too). Only active members of the photo's rollo can read or write them: unlike likes there is no
 * path through a profile, because a comment shows names and conversations of the rollo to people who are not in it.
 */

/** The most comments one photo returns. A rollo is a group of friends: this is a safety net, not a page size. */
const LIST_LIMIT = 500;

type Photo = { id: string; tripId: string; authorUserId: string; viewerIsAdmin: boolean; type: "photo" | "video"; archived: boolean };

/**
 * The photo if the viewer can comment on it: an active member of its rollo once revealed (a daily moment, from the moment
 * it is uploaded: the only photo anyone sees before the reveal), the photo not hidden for them
 * (reported, or its author blocked) and no block with its author in either direction. Anything else → 404, without
 * telling whether it exists.
 */
async function visiblePhoto(db: D1Database, viewerId: string, mediaId: string, now: number): Promise<Photo> {
  const row = await repo.findCommentableRow(db, viewerId, mediaId);
  const isMoment = row?.moment_day != null || row?.paired_media_id != null; // the linked image gets its 400 below
  if (!row || row.is_member !== 1 || !(isMoment || isRevealed(row, now))) throw notFound();
  if (row.author_user_id !== viewerId && (await isBlockedEitherWay(db, viewerId, row.author_user_id))) throw notFound();
  rejectSelfie(row.paired_media_id);
  return { id: row.id, tripId: row.trip_id, authorUserId: row.author_user_id, viewerIsAdmin: row.is_admin === 1, type: row.type, archived: row.archived_at !== null };
}

/** Who can delete a comment: its author, the author of the photo or the admin of the rollo (the viewer is already an active member). */
function canDeleteComment(commentUserId: string, viewerId: string, photo: Pick<Photo, "authorUserId" | "viewerIsAdmin">): boolean {
  return commentUserId === viewerId || photo.authorUserId === viewerId || photo.viewerIsAdmin;
}

function present(row: repo.CommentRow, viewerId: string, photo: Pick<Photo, "authorUserId" | "viewerIsAdmin">) {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    author: { userId: row.user_id, name: row.name ?? "", username: row.username, avatarUrl: avatarUrl(row.user_id, row.avatar_key) },
    canDelete: canDeleteComment(row.user_id, viewerId, photo),
  };
}

export async function listComments(db: D1Database, viewerId: string, mediaId: string) {
  const photo = await visiblePhoto(db, viewerId, mediaId, Date.now());
  // A video can't have comments: its list is empty rather than an error, so the app can ask without checking the type.
  if (photo.type !== "photo") return [];
  return (await repo.listComments(db, viewerId, photo.id, LIST_LIMIT)).map((r) => present(r, viewerId, photo));
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
    photo,
  );
  // An archived photo only reaches its author (the only one who can comment on it now): nobody else is told.
  return { comment, notify: photo.archived ? null : () => notifyComment(env, viewer, photo, now) };
}

/** The author of the comment, the author of its photo or the rollo admin deletes it (soft). Another member → 403; anyone who can't see it → 404. */
export async function deleteComment(db: D1Database, viewerId: string, commentId: string): Promise<void> {
  const comment = await repo.findComment(db, commentId);
  if (!comment) throw notFound();
  const photo = await visiblePhoto(db, viewerId, comment.media_id, Date.now());
  if (!canDeleteComment(comment.user_id, viewerId, photo)) throw forbidden("No podés borrar este comentario");
  await repo.softDeleteComment(db, commentId, Date.now()).run();
}

/** After a "photoCommented" push, the next comments on that photo within this window are counted but not notified. */
export const COMMENT_PUSH_WINDOW_MS = 30 * 60_000;

type PushPhoto = { id: string; tripId: string };

/** Opens the photo in its rollo's gallery with the comments sheet. */
const photoUrl = (photo: PushPhoto) => `/photo/${photo.id}?tripId=${photo.tripId}&comments=1`;

/** "Cami comentó tu foto" / "Cami y 3 más comentaron tu foto". */
export function photoCommentedMessage(commenter: Pick<UserRow, "name" | "username">, silenced: number, photo: PushPhoto): PushMessage {
  const who = actorName(commenter);
  return { body: silenced > 0 ? `${who} y ${silenced} más comentaron tu foto` : `${who} comentó tu foto`, url: photoUrl(photo) };
}

/** For those who commented before: "Cami también comentó una foto" / "Cami y 3 más también comentaron una foto". */
export function alsoCommentedMessage(commenter: Pick<UserRow, "name" | "username">, silenced: number, photo: PushPhoto): PushMessage {
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
async function claimCommentPush(db: D1Database, mediaId: string, now: number): Promise<number | null> {
  const [before, claim] = await db.batch<{ silenced: number }>([
    repo.selectSilencedComments(db, mediaId),
    repo.claimCommentPushWindow(db, mediaId, now, now - COMMENT_PUSH_WINDOW_MS),
  ]);
  if (claim!.meta.changes > 0) return before!.results[0]?.silenced ?? 0;
  await repo.countSilencedComment(db, mediaId).run();
  return null;
}

/** After a new comment: the anti-spam decision and, if it's time, the push to the author and to those who commented before. */
async function notifyComment(
  env: Pick<Env, "DB">,
  commenter: Pick<UserRow, "id" | "name" | "username">,
  photo: PushPhoto & { authorUserId: string },
  now: number,
): Promise<void> {
  const silenced = await claimCommentPush(env.DB, photo.id, now);
  if (silenced === null) return;
  const opts = { actorId: commenter.id };
  await sendPush(env, [photo.authorUserId], "photoCommented", photoCommentedMessage(commenter, silenced, photo), opts);
  const others = await repo.listEarlierCommenters(env.DB, photo.tripId, photo.id, photo.authorUserId);
  if (others.length) await sendPush(env, others, "photoCommented", alsoCommentedMessage(commenter, silenced, photo), opts);
}

/** Your comments on photos you can open today in the gallery, newest first (filtered in SQL, see `repo.listMyComments`). */
export async function listMyComments(
  db: D1Database,
  viewerId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ items: MyComment[]; nextCursor: string | null; total: number }> {
  const now = Date.now();
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const [rows, total] = await Promise.all([
    repo.listMyComments(db, viewerId, now, opts.limit + 1, after && { createdAt: after.at, commentId: after.id }),
    repo.countMyComments(db, viewerId, now),
  ]);
  const page = rows.slice(0, opts.limit);
  const items = page.map(
    (r): MyComment => ({
      commentId: r.comment_id,
      mediaId: r.media_id,
      tripId: r.trip_id,
      text: r.text,
      createdAt: r.created_at,
      thumbPath: `/trips/${r.trip_id}/media/${r.media_id}/thumb`,
      thumbHash: r.thumbhash,
    }),
  );
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > opts.limit && last ? encodeCursor({ at: last.created_at, id: last.comment_id }) : null, total };
}

export type MyComment = {
  commentId: string;
  mediaId: string;
  tripId: string;
  text: string;
  createdAt: number;
  thumbPath: string;
  thumbHash: string | null;
};
