import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { FriendParams } from "../../schemas";
import * as controller from "./friends.controller";
import {
  ClaimFriendLinkSchema,
  ClaimResponseSchema,
  FriendLinkSchema,
  FriendProfileSchema,
  FriendResponseSchema,
  FriendsSchema,
  RedeemFriendSchema,
} from "./friends.schemas";

const tags = ["Friends"];

// ---------- Generate a link ----------

export const linkRoute = createRoute({
  method: "post",
  path: "/link",
  tags,
  summary: "Generate a friend link",
  description:
    "Returns an 8-character code (the link is https://rollo.juanifraga.com/friends#<code>; rollo://friends/<code> is still accepted) valid for 1 hour and reusable while it lives. " +
    "Generating a new one invalidates the previous links of the user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(FriendLinkSchema, "Friend link"), ...errors(401) },
});

// ---------- Claim (no session) ----------

export const claimRoute = createRoute({
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

// ---------- Redeem ----------

export const redeemRoute = createRoute({
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

// ---------- List ----------

export const listRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Your friends",
  description: "Ordered by name.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(FriendsSchema, "Friends"), ...errors(401) },
});

// ---------- Profile ----------

export const profileRoute = createRoute({
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

// ---------- Remove ----------

export const removeRoute = createRoute({
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

const friends = createApp();
export const friendLinks = createApp();

friends.openapi(linkRoute, controller.link);
friendLinks.openapi(claimRoute, controller.claim);
friends.openapi(redeemRoute, controller.redeem);
friends.openapi(listRoute, controller.list);
friends.openapi(profileRoute, controller.profile);
friends.openapi(removeRoute, controller.remove);

export default friends;
