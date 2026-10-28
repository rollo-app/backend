import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { MediaParams } from "../../schemas";
import * as controller from "./comments.controller";
import { CommentListSchema, CommentParams, CommentSchema, CreateCommentSchema, MyCommentsQuery, MyCommentsSchema } from "./comments.schemas";

const tags = ["Comments"];

export const listCommentsRoute = createRoute({
  method: "get",
  path: "/media/{mediaId}/comments",
  tags,
  summary: "List the comments of a photo",
  description:
    "Oldest first. Only active members of the photo's rollo, once it is revealed: otherwise 404 (also with a block with the photo's author). " +
    "Leaves out deleted comments, comments of users blocked in either direction and the ones you reported. A video has none (empty list).",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 200: json(CommentListSchema, "Comments"), ...errors(401, 404) },
});

export const createCommentRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/comments",
  tags,
  summary: "Comment on a photo",
  description:
    "Plain text, up to 500 characters. Same permissions as listing; 400 for a video. " +
    "Notifies the photo's author and whoever commented before (`photoCommented`), at most once every 30 minutes per photo: " +
    "the comments in between are counted and added to the next push.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE")] as const,
  request: { params: MediaParams, body: { content: { "application/json": { schema: CreateCommentSchema } }, required: true } },
  responses: { 201: json(CommentSchema, "The new comment"), ...errors(400, 401, 404, 429) },
});

export const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/comments/{commentId}",
  tags,
  summary: "Delete a comment",
  description:
    "The author of the comment or the author of its photo. Another member of the rollo gets 403. " +
    "404 if the comment does not exist, is already deleted, or you can't see its photo.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: CommentParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404) },
});

export const myCommentsRoute = createRoute({
  method: "get",
  path: "/me/comments",
  tags,
  summary: "Comments you wrote",
  description:
    "Only yours. Your live comments on photos you can open today in a rollo gallery, newest first, paginated with `cursor`. " +
    "Filtered by the server: a comment drops out if you deleted it, its photo was deleted, archived by its author (yours stay), " +
    "its rollo is not revealed or you left it, there is a block with the photo's author or you reported the photo " +
    "(it comes back if you regain access). Open it at `/photo/<mediaId>?tripId=<tripId>&comments=1`.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { query: MyCommentsQuery },
  responses: { 200: json(MyCommentsSchema, "A page of your comments"), ...errors(400, 401) },
});

const comments = createApp();

comments.openapi(listCommentsRoute, controller.list);
comments.openapi(createCommentRoute, controller.create);
comments.openapi(deleteCommentRoute, controller.remove);
comments.openapi(myCommentsRoute, controller.myComments);

export default comments;
