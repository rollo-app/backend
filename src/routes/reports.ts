import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { sendReportEmail } from "../lib/email";
import { withinModerationEmailCap } from "../lib/moderation";
import { bearerAuth, createApp, errors } from "../lib/openapi";
import { canSeeProfile } from "../lib/profile-access";
import { presignGet } from "../lib/r2";
import { CreateReportSchema } from "../schemas";
import type { MediaRow, UserRow } from "../types";
import { VISIBLE_FROM, VISIBLE_WHERE } from "./featured";

const reports = createApp();

const route = createRoute({
  method: "post",
  path: "/",
  tags: ["Reports"],
  summary: "Report a photo or a person",
  description:
    "Send `mediaId` or `userId`. Idempotent: reporting the same photo or person again is a 204 and does not email support again. " +
    "A reported photo disappears from the reporter's own views (and from their featured photos). At most 10 reports and blocks per user per 24 hours are emailed to support; the rest are stored without email. 404 if the photo is not one the reporter can see; 400 if it is theirs.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: CreateReportSchema } }, required: true } },
  responses: { 204: { description: "Reported" }, ...errors(400, 401, 404) },
});

const notFound = () => new HTTPException(404, { message: "No encontrado" });

/** Whether the viewer may see the photo: active member of its trip, or a featured photo on a profile they can see. */
async function canSeeMedia(db: D1Database, viewerId: string, media: Pick<MediaRow, "id" | "trip_id">): Promise<boolean> {
  const member = await db
    .prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(media.trip_id, viewerId)
    .first();
  if (member) return true;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.profile_visibility FROM ${VISIBLE_FROM} JOIN users u ON u.id = f.user_id
       WHERE ${VISIBLE_WHERE} AND f.media_id = ?`,
    )
    .bind(Date.now(), media.id)
    .all<Pick<UserRow, "id" | "profile_visibility">>();
  for (const owner of results) if (await canSeeProfile(db, viewerId, owner)) return true;
  return false;
}

reports.openapi(route, async (c) => {
  const db = c.env.DB;
  const viewer = c.get("user");
  const { reason, mediaId, userId } = c.req.valid("json");

  let targetId: string;
  let media: MediaRow | null = null;
  if (mediaId !== undefined) {
    media = await db.prepare("SELECT * FROM media WHERE id = ? AND status = 'uploaded' AND deleted_at IS NULL").bind(mediaId).first<MediaRow>();
    if (!media || !(await canSeeMedia(db, viewer.id, media))) throw notFound();
    const author = await db.prepare("SELECT user_id FROM members WHERE id = ?").bind(media.member_id).first<{ user_id: string }>();
    if (!author) throw notFound();
    targetId = author.user_id;
  } else {
    targetId = userId!;
  }

  const target = await db.prepare("SELECT id, email, name, username FROM users WHERE id = ?").bind(targetId).first<Pick<UserRow, "id" | "email" | "name" | "username">>();
  if (!target) throw notFound();
  if (target.id === viewer.id) throw new HTTPException(400, { message: mediaId !== undefined ? "No podés denunciar tu propia foto" : "No podés denunciarte a vos mismo" });

  const inserted = await db
    .prepare("INSERT OR IGNORE INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), viewer.id, media?.id ?? null, target.id, media?.trip_id ?? null, reason, Date.now())
    .run();

  if (inserted.meta.changes === 1) {
    // A reported photo also leaves the reporter's own featured list (and its cap).
    if (media) await db.prepare("DELETE FROM featured WHERE user_id = ? AND media_id = ?").bind(viewer.id, media.id).run();
    try {
      if (!(await withinModerationEmailCap(db, viewer.id))) return c.body(null, 204);
      const trip = media ? await db.prepare("SELECT name FROM trips WHERE id = ?").bind(media.trip_id).first<{ name: string }>() : null;
      await sendReportEmail(c.env, {
        reason,
        reporter: { id: viewer.id, name: viewer.name, username: viewer.username, email: viewer.email },
        target: { id: target.id, name: target.name, username: target.username, email: target.email },
        ...(trip && { trip: { name: trip.name } }),
        ...(media && {
          media: {
            id: media.id,
            type: media.type,
            caption: media.caption,
            takenAt: media.taken_at,
            url: await presignGet(c.env, media.original_key),
          },
        }),
        adminBase: new URL(c.req.url).origin,
      });
    } catch (err) {
      // The report is already saved; do not fail the request because support was not emailed.
      console.error("[report] could not email support", err);
    }
  }
  return c.body(null, 204);
});

export default reports;
