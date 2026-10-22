import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
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
    "Idempotent and one-directional. Also removes the friendship in both directions. Does not remove anyone from a rollo.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Blocked" }, ...errors(400, 401, 404) },
});

blocks.openapi(blockRoute, async (c) => {
  const me = c.get("user").id;
  const target = c.req.valid("param").userId;
  if (target === me) throw new HTTPException(400, { message: "No podés bloquearte" });
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(target).first();
  if (!exists) throw new HTTPException(404, { message: "No existe ese usuario" });
  const [a, b] = pairKey(me, target);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(me, target, Date.now()),
    c.env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b),
  ]);
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
