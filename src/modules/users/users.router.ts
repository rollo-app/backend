import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { rateLimit } from "../../lib/rate-limit";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { UserParams } from "../../schemas";
import * as controller from "./users.controller";
import { UserFriendsSchema, UserProfileSchema, UserSearchQuerySchema, UserSearchSchema } from "./users.schemas";

const tags = ["Users"];

export const searchRoute = createRoute({
  method: "get",
  path: "/search",
  tags,
  summary: "Search users by @username or name",
  description:
    "Finds people to add as friends: the username starts with q, or the name or any word of it does (case and accents ignored). " +
    "Never lists yourself, your friends, anyone with a block in either direction, or accounts without a username or a name. " +
    "Order: exact username first, then most mutual friends, then by name. At most 20, no paging. " +
    "400 if q has fewer than 2 or more than 30 characters once trimmed and without the leading @. Limited per user (429).",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_SEARCH")] as const,
  request: { query: UserSearchQuerySchema },
  responses: { 200: json(UserSearchSchema, "Matching users"), ...errors(400, 401, 429) },
});

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

// Before profileRoute: `/{userId}` accepts any string and would swallow `/search`.
users.openapi(searchRoute, controller.search);
users.openapi(profileRoute, controller.profile);
users.openapi(friendsRoute, controller.friends);

export default users;
