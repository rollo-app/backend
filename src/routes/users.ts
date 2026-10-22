import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { areFriends, canSeeProfile } from "../lib/profile-access";
import { avatarUrl } from "../lib/util";
import { UserParams, UserProfileSchema } from "../schemas";
import type { UserRow } from "../types";

const users = createApp();
const tags = ["Users"];

const profileRoute = createRoute({
  method: "get",
  path: "/{userId}",
  tags,
  summary: "A user's profile",
  description:
    "Name, username and avatar are always visible. The bio (and featured photos) only if canSee: it is you, " +
    "a friend, or the profile is public; otherwise bio is null. Never includes the email. 404 if the user does not exist.",
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

  const canSee = await canSeeProfile(c.env.DB, viewerId, owner);
  return c.json(
    {
      user: {
        id: owner.id,
        name: owner.name ?? "",
        username: owner.username,
        avatarUrl: avatarUrl(owner.id, owner.avatar_key),
        bio: canSee ? owner.bio : null,
      },
      isFriend: await areFriends(c.env.DB, viewerId, owner.id),
      profileVisibility: owner.profile_visibility,
      canSee,
    },
    200,
  );
});

export default users;
