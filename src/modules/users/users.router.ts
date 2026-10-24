import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { UserParams } from "../../schemas";
import * as controller from "./users.controller";
import { UserFriendsSchema, UserProfileSchema } from "./users.schemas";

const tags = ["Users"];

export const profileRoute = createRoute({
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

export const friendsRoute = createRoute({
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

const users = createApp();

users.openapi(profileRoute, controller.profile);
users.openapi(friendsRoute, controller.friends);

export default users;
