import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { FriendParams, UserParams } from "../../schemas";
import { FriendResponseSchema } from "../friends/friends.schemas";
import * as controller from "./friend-requests.controller";
import { ReceivedFriendRequestsSchema, SendFriendRequestResponseSchema } from "./friend-requests.schemas";

const tags = ["Friend requests"];

export const sendRoute = createRoute({
  method: "post",
  path: "/{userId}/friend-request",
  tags,
  summary: "Send a friend request",
  description:
    "Asks to become friends with someone whose profile you can open. They are friends only once the receiver accepts. " +
    "If they already sent you one, you become friends at once (`friends`). Sending again while it is pending, or to a friend, is not an error. " +
    "A request the receiver rejected is silent: you still get `sent`, nothing reaches them until 30 days after the rejection. " +
    "Notifies the receiver (`friendRequest`). 400 to yourself, 404 if the user does not exist or there is a block in either direction, " +
    "429 past 30 sent requests in 24 hours.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE")] as const,
  request: { params: UserParams },
  responses: { 200: json(SendFriendRequestResponseSchema, "Request status"), ...errors(400, 401, 404, 429) },
});

export const cancelRoute = createRoute({
  method: "delete",
  path: "/{userId}/friend-request",
  tags,
  summary: "Cancel a friend request you sent",
  description: "Also 204 if there was none.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UserParams },
  responses: { 204: { description: "Request cancelled" }, ...errors(401) },
});

export const listRoute = createRoute({
  method: "get",
  path: "/friend-requests",
  tags,
  summary: "Friend requests you received",
  description: "Pending ones only (the ones you rejected are gone), most recent first.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(ReceivedFriendRequestsSchema, "Received requests"), ...errors(401) },
});

export const acceptRoute = createRoute({
  method: "post",
  path: "/friend-requests/{userId}/accept",
  tags,
  summary: "Accept a friend request",
  description: "Makes you friends and notifies whoever sent it (`newFriend`). 404 if there is no pending request from that user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 200: json(FriendResponseSchema, "The new friend"), ...errors(401, 404) },
});

export const rejectRoute = createRoute({
  method: "post",
  path: "/friend-requests/{userId}/reject",
  tags,
  summary: "Reject a friend request",
  description: "Silent: the sender is not notified and keeps seeing it as sent. Also 204 if there was none.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Request rejected" }, ...errors(401) },
});

/** Mounted at /users. */
export const userFriendRequests = createApp();
userFriendRequests.openapi(sendRoute, controller.send);
userFriendRequests.openapi(cancelRoute, controller.cancel);

/** Mounted at /me. */
export const meFriendRequests = createApp();
meFriendRequests.openapi(listRoute, controller.list);
meFriendRequests.openapi(acceptRoute, controller.accept);
meFriendRequests.openapi(rejectRoute, controller.reject);
