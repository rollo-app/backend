import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { FriendParams } from "../../schemas";
import * as controller from "./blocks.controller";
import { BlocksSchema } from "./blocks.schemas";

const tags = ["Blocks"];

// ---------- List ----------

export const listRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Users you blocked",
  description: "Ordered by name.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(BlocksSchema, "Blocked users"), ...errors(401) },
});

// ---------- Block ----------

export const blockRoute = createRoute({
  method: "put",
  path: "/{userId}",
  tags,
  summary: "Block a user",
  description:
    "Idempotent and one-directional. Also removes the friendship in both directions. Does not remove anyone from a rollo. Also removes the blocked user's photos from your featured list. A new block is emailed to support (at most 3 reports and blocks per user per 24 hours, and 20 per day overall, are emailed). More than 50 blocks per user per 24 hours is a 429.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: FriendParams },
  responses: { 204: { description: "Blocked" }, ...errors(400, 401, 404, 429) },
});

// ---------- Unblock ----------

export const unblockRoute = createRoute({
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

const blocks = createApp();

blocks.openapi(listRoute, controller.list);
blocks.openapi(blockRoute, controller.block);
blocks.openapi(unblockRoute, controller.unblock);

export default blocks;
