import { createRoute, z } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { MediaParams, UserParams } from "../../schemas";
import * as controller from "./featured.controller";
import { FeaturedFileParams, FeaturedPhotosSchema, MAX_FEATURED } from "./featured.schemas";

const tags = ["Featured"];

// ---------- Feature / unfeature ----------

export const featureRoute = createRoute({
  method: "put",
  path: "/me/featured/{mediaId}",
  tags,
  summary: "Feature a photo on your profile",
  description:
    `A photo (not a video) of a revealed rollo you are an active member of, yours or someone else's. Idempotent. ` +
    `404 if it does not exist or you are not an active member; 409 if the rollo is not revealed, if its author ` +
    `does not let others feature it (unless you took it) or if you already have ${MAX_FEATURED}; 400 for a video.`,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Featured" }, ...errors(400, 401, 404, 409) },
});

export const unfeatureRoute = createRoute({
  method: "delete",
  path: "/me/featured/{mediaId}",
  tags,
  summary: "Remove a photo from your profile",
  description: "204 also if it was not featured.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Not featured anymore" }, ...errors(401) },
});

// ---------- A user's featured photos ----------

export const listRoute = createRoute({
  method: "get",
  path: "/users/{userId}/featured",
  tags,
  summary: "A user's featured photos",
  description:
    "Newest photo first (by when it was taken). Only if you can see the profile (it is you, a friend, or it is public); otherwise 403. " +
    "Each photo carries a ~5 km zone instead of its location, its author when it is not the owner, and its likes; never the rollo or the caption. " +
    "Photos you reported or by authors you blocked, and photos that were deleted, blocked by their author, or whose rollo the owner left do not show up.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UserParams },
  responses: { 200: json(FeaturedPhotosSchema, "Featured photos"), ...errors(401, 403, 404) },
});

// ---------- Files ----------

export const fileRoute = createRoute({
  method: "get",
  path: "/featured/{userId}/{mediaId}/{variant}",
  tags,
  summary: "File of a featured photo",
  description:
    "Streamed from R2 under the profile's permission (not the rollo's): 403 if you can't see the profile, " +
    "404 if that user does not feature this photo (or it no longer shows on their profile). Same caching as the trip download.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_FILES")] as const,
  request: { params: FeaturedFileParams },
  responses: {
    200: { description: "File", content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errors(400, 401, 403, 404, 429),
  },
});

const featured = createApp();

featured.openapi(featureRoute, controller.feature);
featured.openapi(unfeatureRoute, controller.unfeature);
featured.openapi(listRoute, controller.list);
featured.openapi(fileRoute, controller.file);

export default featured;
