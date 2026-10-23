import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateToken, hashToken, requireUser } from "../lib/auth";
import {
  FRIEND_CLAIM_TTL,
  FRIEND_LINK_TTL,
  generateFriendCode,
  normalizeFriendCode,
  pairKey,
} from "../lib/friend-code";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { isBlockedEitherWay } from "../lib/moderation";
import { actorName, deferPush, sendPush } from "../lib/push";
import { areFriends } from "../lib/profile-access";
import { avatarUrl, isRevealed } from "../lib/util";
import {
  ClaimFriendLinkSchema,
  ClaimResponseSchema,
  FriendLinkSchema,
  FriendParams,
  FriendProfileSchema,
  FriendResponseSchema,
  FriendsSchema,
  RedeemFriendSchema,
} from "../schemas";
import type { AppEnv, TripRow } from "../types";

const friends = createApp();
export const friendLinks = createApp();
const tags = ["Friends"];

const HOUR = 3_600_000;
const MAX_FAILED_ATTEMPTS = 10;
const BAD_CODE = "Código incorrecto o vencido";

type PublicFriendRow = { id: string; name: string | null; username: string | null; avatar_key: string | null; bio: string | null };
const publicFriend = (u: PublicFriendRow) => ({
  id: u.id,
  name: u.name ?? "",
  username: u.username,
  avatarUrl: avatarUrl(u.id, u.avatar_key),
  bio: u.bio,
});

// ---------- Rate limit (failed attempts per user and per IP) ----------

function attemptKeys(c: Context<AppEnv>, userId?: string): string[] {
  const ip = c.req.header("cf-connecting-ip");
  return [...(userId ? [`user:${userId}`] : []), ...(ip ? [`ip:${ip}`] : [])];
}

/** Throws 429 if any of the keys already has too many failed attempts in the last hour. */
async function assertNotLocked(c: Context<AppEnv>, keys: string[]) {
  const since = Date.now() - HOUR;
  for (const key of keys) {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM friend_attempts WHERE key = ? AND created_at > ?")
      .bind(key, since)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
      throw new HTTPException(429, { message: "Demasiados intentos, probá más tarde" });
    }
  }
}

/** Records a failed attempt under every key and answers with the generic error (never says why it failed). */
async function failAttempt(c: Context<AppEnv>, keys: string[]): Promise<never> {
  const now = Date.now();
  if (keys.length) {
    await c.env.DB.batch(
      keys.map((key) =>
        c.env.DB.prepare("INSERT INTO friend_attempts (id, key, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), key, now),
      ),
    );
  }
  throw new HTTPException(400, { message: BAD_CODE });
}

// ---------- Generate a link ----------

const linkRoute = createRoute({
  method: "post",
  path: "/link",
  tags,
  summary: "Generate a friend link",
  description:
    "Returns an 8-character code (the link is rollo://friends/<code>) valid for 1 hour and reusable while it lives. " +
    "Generating a new one invalidates the previous links of the user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(FriendLinkSchema, "Friend link"), ...errors(401) },
});

friends.openapi(linkRoute, async (c) => {
  const user = c.get("user");
  const now = Date.now();
  const code = generateFriendCode();
  const expiresAt = now + FRIEND_LINK_TTL;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM friend_links WHERE user_id = ?").bind(user.id),
    // Pending claims are NOT deleted when a new link is generated: on purpose, so whoever opened the old link in
    // time can still finish signing up. Only expired claims are cleaned up.
    c.env.DB.prepare("DELETE FROM friend_claims WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare("DELETE FROM friend_attempts WHERE created_at <= ?").bind(now - HOUR),
    c.env.DB.prepare("INSERT INTO friend_links (id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      crypto.randomUUID(), user.id, await hashToken(code), now, expiresAt,
    ),
  ]);
  return c.json({ code, expiresAt }, 200);
});

// ---------- Claim (no session) ----------

const claimRoute = createRoute({
  method: "post",
  path: "/claim",
  tags,
  summary: "Open a friend link (no session needed)",
  description:
    "For someone who opens the link before having an account. Returns who invited them and a claim token (valid 24 hours) " +
    "to redeem the friendship once signed in. A wrong, expired or replaced code always gets the same 400. Rate limited per IP.",
  request: { body: { content: { "application/json": { schema: ClaimFriendLinkSchema } }, required: true } },
  responses: { 200: json(ClaimResponseSchema, "Claim token"), ...errors(400, 429) },
});

friendLinks.openapi(claimRoute, async (c) => {
  const keys = attemptKeys(c);
  await assertNotLocked(c, keys);
  const code = normalizeFriendCode(c.req.valid("json").code);
  if (code === null) return failAttempt(c, keys);

  const now = Date.now();
  const link = await c.env.DB.prepare(
    `SELECT l.user_id, u.name, u.username, u.avatar_key
     FROM friend_links l JOIN users u ON u.id = l.user_id
     WHERE l.code_hash = ? AND l.expires_at > ?`,
  )
    .bind(await hashToken(code), now)
    .first<{ user_id: string; name: string | null; username: string | null; avatar_key: string | null }>();
  if (!link) return failAttempt(c, keys);

  const claimToken = generateToken();
  const expiresAt = now + FRIEND_CLAIM_TTL;
  await c.env.DB.prepare(
    "INSERT INTO friend_claims (id, link_user_id, claim_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), link.user_id, await hashToken(claimToken), now, expiresAt)
    .run();

  return c.json(
    { claimToken, expiresAt, creator: { name: link.name ?? "", username: link.username, avatarUrl: avatarUrl(link.user_id, link.avatar_key) } },
    200,
  );
});

// ---------- Redeem ----------

const redeemRoute = createRoute({
  method: "post",
  path: "/redeem",
  tags,
  summary: "Become friends with whoever made a link",
  description:
    "Send exactly one of `code` (a link that is still valid) or `claimToken` (from /friend-links/claim, valid 24 hours, single use). " +
    "The friendship is symmetric and needs no acceptance. Redeeming your own link or one from a current friend is not an error. " +
    "A wrong, expired or replaced code always gets the same 400. 10 failed attempts per user or per IP in an hour lock it (429).",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: RedeemFriendSchema } }, required: true } },
  responses: { 200: json(FriendResponseSchema, "The new (or existing) friend"), ...errors(400, 401, 429) },
});

friends.openapi(redeemRoute, async (c) => {
  const me = c.get("user");
  const keys = attemptKeys(c, me.id);
  await assertNotLocked(c, keys);
  const body = c.req.valid("json");
  const now = Date.now();

  let creatorId: string | undefined;
  if (body.claimToken !== undefined) {
    // Single use, atomically: only one redeem can flip used_at.
    const claim = await c.env.DB.prepare(
      "UPDATE friend_claims SET used_at = ? WHERE claim_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING link_user_id",
    )
      .bind(now, await hashToken(body.claimToken), now)
      .first<{ link_user_id: string }>();
    creatorId = claim?.link_user_id;
  } else {
    const code = normalizeFriendCode(body.code ?? "");
    if (code !== null) {
      const link = await c.env.DB.prepare("SELECT user_id FROM friend_links WHERE code_hash = ? AND expires_at > ?")
        .bind(await hashToken(code), now)
        .first<{ user_id: string }>();
      creatorId = link?.user_id;
    }
  }
  if (!creatorId) return failAttempt(c, keys);

  // A block in either direction fails exactly like an invalid link.
  if (creatorId !== me.id && (await isBlockedEitherWay(c.env.DB, me.id, creatorId))) return failAttempt(c, keys);

  const creator = (await c.env.DB.prepare("SELECT id, name, username, avatar_key, bio FROM users WHERE id = ?")
    .bind(creatorId)
    .first<PublicFriendRow>())!;

  if (creatorId !== me.id) {
    const [a, b] = pairKey(me.id, creatorId);
    const inserted = await c.env.DB.prepare("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)")
      .bind(a, b, now)
      .run();
    if (inserted.meta.changes > 0) {
      deferPush(c, sendPush(c.env, [creatorId], "newFriend", { body: `${actorName(me)} ahora es tu amigo`, url: `/user/${me.id}` }, { actorId: me.id }));
    }
  }
  return c.json({ friend: publicFriend(creator) }, 200);
});

// ---------- List ----------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Your friends",
  description: "Ordered by name.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(FriendsSchema, "Friends"), ...errors(401) },
});

friends.openapi(listRoute, async (c) => {
  const id = c.get("user").id;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.avatar_key, u.bio
     FROM users u
     WHERE u.id IN (SELECT user_b FROM friendships WHERE user_a = ?1 UNION SELECT user_a FROM friendships WHERE user_b = ?1)
     ORDER BY u.name COLLATE NOCASE, u.id`,
  )
    .bind(id)
    .all<PublicFriendRow>();
  return c.json({ friends: results.map(publicFriend) }, 200);
});

// ---------- Profile ----------

const profileRoute = createRoute({
  method: "get",
  path: "/{userId}",
  tags,
  summary: "A friend's profile",
  description:
    "The friend and the rollos both of you are active members of (neither left nor was removed), most recent start first. " +
    "404 if you are not friends, also for an unknown id or your own.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 200: json(FriendProfileSchema, "Friend profile"), ...errors(401, 404) },
});

friends.openapi(profileRoute, async (c) => {
  const me = c.get("user").id;
  const friendId = c.req.valid("param").userId;
  // Yourself is never a friend, so it falls into the same 404.
  if (!(await areFriends(c.env.DB, me, friendId))) throw new HTTPException(404, { message: "No es tu amigo" });
  const friend = await c.env.DB.prepare("SELECT id, name, username, avatar_key, bio FROM users WHERE id = ?")
    .bind(friendId)
    .first<PublicFriendRow>();
  if (!friend) throw new HTTPException(404, { message: "No es tu amigo" });

  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT t.*
     FROM trips t
     JOIN members mine ON mine.trip_id = t.id AND mine.user_id = ?1 AND mine.removed_at IS NULL AND mine.left_at IS NULL
     JOIN members theirs ON theirs.trip_id = t.id AND theirs.user_id = ?2 AND theirs.removed_at IS NULL AND theirs.left_at IS NULL
     ORDER BY t.starts_at DESC, t.id`,
  )
    .bind(me, friendId)
    .all<TripRow>();

  return c.json(
    {
      friend: publicFriend(friend),
      commonTrips: results.map((t) => ({
        id: t.id,
        name: t.name,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        revealed: isRevealed(t, now),
      })),
    },
    200,
  );
});

// ---------- Remove ----------

const removeRoute = createRoute({
  method: "delete",
  path: "/{userId}",
  tags,
  summary: "Remove a friend",
  description: "Removes the friendship in both directions. Also 204 if you were not friends. Rollos you share are not affected.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Friendship removed" }, ...errors(401) },
});

friends.openapi(removeRoute, async (c) => {
  const [a, b] = pairKey(c.get("user").id, c.req.valid("param").userId);
  await c.env.DB.prepare("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").bind(a, b).run();
  return c.body(null, 204);
});

export default friends;
