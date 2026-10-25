import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { MediaParams } from "../../schemas";
import * as controller from "./likes.controller";

const tags = ["Likes"];

export const likeRoute = createRoute({
  method: "put",
  path: "/media/{mediaId}/like",
  tags,
  summary: "Like a photo",
  description:
    "Idempotent. Whoever can see the photo can like it: an active member of its rollo once it is revealed, or anyone who can " +
    "see a profile where it is featured. Otherwise 404 (also with a block with its author); 400 for a video. " +
    "Notifies the author (`photoLiked`) at most once every 30 minutes per photo: the likes in between are counted and added " +
    "to the next push (\"A Cami y 3 más les gustó tu foto\").",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("expensive")] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Liked" }, ...errors(400, 401, 404, 429) },
});

export const unlikeRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}/like",
  tags,
  summary: "Remove your like from a photo",
  description: "Idempotent: 204 also if you did not like it (or the photo does not exist). Never notifies.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Not liked anymore" }, ...errors(401) },
});

const likes = createApp();

likes.openapi(likeRoute, controller.like);
likes.openapi(unlikeRoute, controller.unlike);

export default likes;
