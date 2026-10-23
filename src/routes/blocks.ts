import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { sendBlockEmail } from "../lib/email";
import { atModerationActionCap, MODERATION_ACTION_CAP_MESSAGE, withinModerationEmailCap } from "../lib/moderation";
import { pairKey } from "../lib/friend-code";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { avatarUrl } from "../lib/util";
import { BlocksSchema, FriendParams } from "../schemas";

const blocks = createApp();
const tags = ["Blocks"];

// ---------- List ----------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Users you blocked",
  description: "Ordered by name.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(BlocksSchema, "Blocked users"), ...errors(401) },
});

blocks.openapi(listRoute, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.avatar_key, u.bio
     FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ?
     ORDER BY u.name COLLATE NOCASE, u.id`,
  )
    .bind(c.get("user").id)
    .all<{ id: string; name: string | null; username: string | null; avatar_key: string | null; bio: string | null }>();
  return c.json(
    {
      blocked: results.map((u) => ({
        id: u.id,
        name: u.name ?? "",
        username: u.username,
        avatarUrl: avatarUrl(u.id, u.avatar_key),
        bio: u.bio,
      })),
    },
    200,
  );
});

// ---------- Block ----------

const blockRoute = createRoute({
  method: "put",
  path: "/{userId}",
  tags,
  summary: "Block a user",
  description:
    "Idempotent and one-directional. Also removes the friendship in both directions. Does not remove anyone from a rollo. Also removes the blocked user's photos from your featured list. A new block is emailed to support (at most 10 reports and blocks per user per 24 hours, and 20 per day overall, are emailed). More than 50 blocks per user per 24 hours is a 429.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Blocked" }, ...errors(400, 401, 404, 429) },
});

blocks.openapi(blockRoute, async (c) => {
  const me = c.get("user").id;
  const target = c.req.valid("param").userId;
  if (target === me) throw new HTTPException(400, { message: "No podés bloquearte" });
  const blocked = await c.env.DB.prepare("SELECT id, email, name, username FROM users WHERE id = ?").bind(target).first<{ id: string; email: string; name: string | null; username: string | null }>();
  if (!blocked) throw new HTTPException(404, { message: "No existe ese usuario" });
  if (await atModerationActionCap(c.env.DB, "blocks", me)) throw new HTTPException(429, { message: MODERATION_ACTION_CAP_MESSAGE });
  const [a, b] = pairKey(me, target);
  const [inserted] = await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(me, target, Date.now()),
    c.env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b),
    // Their photos leave the blocker's featured list too (and its cap).
    c.env.DB.prepare(
      `DELETE FROM featured WHERE user_id = ? AND media_id IN (
         SELECT m.id FROM media m JOIN members mem ON mem.id = m.member_id WHERE mem.user_id = ?)`,
    ).bind(me, target),
  ]);
  if (inserted!.meta.changes === 1 && (await withinModerationEmailCap(c.env.DB, me))) {
    try {
      const blocker = c.get("user");
      await sendBlockEmail(c.env, {
        blocker: { id: blocker.id, name: blocker.name, username: blocker.username, email: blocker.email },
        blocked: { id: blocked.id, name: blocked.name, username: blocked.username, email: blocked.email },
        adminBase: new URL(c.req.url).origin,
      });
    } catch (err) {
      // The block is already saved; do not fail the request because support was not emailed.
      console.error("[block] could not email support", err);
    }
  }
  return c.body(null, 204);
});

// ---------- Unblock ----------

const unblockRoute = createRoute({
  method: "delete",
  path: "/{userId}",
  tags,
  summary: "Unblock a user",
  description: "Only removes your own block; a block the other user made on you stays. Also 204 if you had not blocked them. Friendship is not restored.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Unblocked" }, ...errors(401) },
});

blocks.openapi(unblockRoute, async (c) => {
  await c.env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
    .bind(c.get("user").id, c.req.valid("param").userId)
    .run();
  return c.body(null, 204);
});

export default blocks;
