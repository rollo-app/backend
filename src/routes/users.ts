import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { isBlockedEitherWay } from "../lib/moderation";
import { areFriends, canSeeProfile } from "../lib/profile-access";
import { avatarUrl } from "../lib/util";
import { UserFriendsSchema, UserParams, UserProfileSchema } from "../schemas";
import type { UserRow } from "../types";

const users = createApp();

/** Subquery: ids of the friends of the user bound at `?N`. */
const friendIdsOf = (n: number) =>
  `SELECT user_b FROM friendships WHERE user_a = ?${n} UNION SELECT user_a FROM friendships WHERE user_b = ?${n}`;

async function friendCounts(db: D1Database, viewerId: string, ownerId: string) {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM (${friendIdsOf(1)})) AS friendCount,
              (SELECT COUNT(*) FROM (${friendIdsOf(1)}) WHERE user_b IN (${friendIdsOf(2)})) AS mutualCount`,
    )
    .bind(ownerId, viewerId)
    .first<{ friendCount: number; mutualCount: number }>();
  return { friendCount: row!.friendCount, mutualCount: viewerId === ownerId ? 0 : row!.mutualCount };
}
const tags = ["Users"];

const profileRoute = createRoute({
  method: "get",
  path: "/{userId}",
  tags,
  summary: "A user's profile",
  description:
    "Name, username, avatar, bio and friend counts are always visible. Featured photos and the full friend list " +
    "only if canSee: it is you, a friend, or the profile is public. Never includes the email. 404 if the user does not exist.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UserParams },
  responses: { 200: json(UserProfileSchema, "User profile"), ...errors(401, 404) },
});

users.openapi(profileRoute, async (c) => {
  const viewerId = c.get("user").id;
  const owner = await c.env.DB.prepare(
    "SELECT id, name, username, avatar_key, bio, profile_visibility FROM users WHERE id = ?",
  )
    .bind(c.req.valid("param").userId)
    .first<Pick<UserRow, "id" | "name" | "username" | "avatar_key" | "bio" | "profile_visibility">>();
  if (!owner) throw new HTTPException(404, { message: "No existe" });

  const flag = async (sql: string) => (await c.env.DB.prepare(sql).bind(viewerId, owner.id).first()) !== null;
  const [blocked, blockedByMe, reportedByMe, counts] = await Promise.all([
    isBlockedEitherWay(c.env.DB, viewerId, owner.id),
    flag("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?"),
    flag("SELECT 1 FROM reports WHERE reporter_id = ? AND target_user_id = ? AND media_id IS NULL"),
    friendCounts(c.env.DB, viewerId, owner.id),
  ]);
  // A blocked pair (either direction) sees a header-only profile: no access, no friendship, no mutual friends.
  const canSee = !blocked && (await canSeeProfile(c.env.DB, viewerId, owner));
  const isFriend = !blocked && (await areFriends(c.env.DB, viewerId, owner.id));
  return c.json(
    {
      user: {
        id: owner.id,
        name: owner.name ?? "",
        username: owner.username,
        avatarUrl: avatarUrl(owner.id, owner.avatar_key),
        bio: owner.bio,
      },
      isFriend,
      blockedByMe,
      reportedByMe,
      profileVisibility: owner.profile_visibility,
      canSee,
      friendCount: counts.friendCount,
      mutualCount: blocked ? 0 : counts.mutualCount,
    },
    200,
  );
});

const friendsRoute = createRoute({
  method: "get",
  path: "/{userId}/friends",
  tags,
  summary: "A user's friends",
  description:
    "If you can see the profile (it is you, a friend, or the profile is public) every friend (scope all); otherwise " +
    "only the friends you have in common (scope mutual). Sorted by name. Only id, name, username and avatar. " +
    "404 if the user does not exist.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UserParams },
  responses: { 200: json(UserFriendsSchema, "User's friends"), ...errors(401, 404) },
});

users.openapi(friendsRoute, async (c) => {
  const viewerId = c.get("user").id;
  const owner = await c.env.DB.prepare("SELECT id, profile_visibility FROM users WHERE id = ?")
    .bind(c.req.valid("param").userId)
    .first<Pick<UserRow, "id" | "profile_visibility">>();
  if (!owner) throw new HTTPException(404, { message: "No existe" });

  if (await isBlockedEitherWay(c.env.DB, viewerId, owner.id)) return c.json({ scope: "mutual" as const, friends: [] }, 200);

  const scope = (await canSeeProfile(c.env.DB, viewerId, owner)) ? "all" : "mutual";
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.avatar_key
     FROM users u
     WHERE u.id IN (${friendIdsOf(1)})${scope === "mutual" ? ` AND u.id IN (${friendIdsOf(2)})` : ""}
     ORDER BY u.name COLLATE NOCASE, u.id`,
  )
    .bind(...(scope === "mutual" ? [owner.id, viewerId] : [owner.id]))
    .all<Pick<UserRow, "id" | "name" | "username" | "avatar_key">>();
  return c.json(
    {
      scope,
      friends: results.map((u) => ({ id: u.id, name: u.name ?? "", username: u.username, avatarUrl: avatarUrl(u.id, u.avatar_key) })),
    },
    200,
  );
});

export default users;
