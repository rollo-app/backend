import { createRoute, z } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { MediaParams, UserParams } from "../../schemas";
import * as controller from "./featured.controller";
import { FeaturedByListSchema, FeaturedByQuery, FeaturedFileParams, FeaturedPhotosSchema, MAX_FEATURED } from "./featured.schemas";

const tags = ["Featured"];

// ---------- Feature / unfeature ----------

export const featureRoute = createRoute({
  method: "put",
  path: "/me/featured/{mediaId}",
  tags,
  summary: "Feature a photo on your profile",
  description:
    `A photo (not a video) of a revealed rollo you are an active member of: yours or a current friend's. Idempotent. ` +
    `404 if it does not exist or you are not an active member; 409 if the rollo is not revealed, if its author is someone ` +
    `who is not your friend, if its author does not let others feature it (unless you took it) or if you already have ${MAX_FEATURED}; ` +
    `400 for a video. When a friendship ends (either side) or one of the two blocks the other, each profile loses the other's photos ` +
    `and they do not come back if the two become friends again.`,
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

export const featuredByRoute = createRoute({
  method: "get",
  path: "/me/featured-by",
  tags,
  summary: "Who featured your photos",
  description:
    "Only yours. The times another user featured one of your photos on their profile, newest first, paginated with `cursor`. " +
    "Only the ones you can see today: you can see that profile (friend or public), there is no block with that user in either direction " +
    "and the photo is still featured there. Your own featuring of your own photos is not listed. " +
    "Open one at `/featured/<user.id>/<mediaId>`; `thumbPath` is served with the permission of that profile.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { query: FeaturedByQuery },
  responses: { 200: json(FeaturedByListSchema, "A page of featurings of your photos"), ...errors(400, 401) },
});

const featured = createApp();

featured.openapi(featureRoute, controller.feature);
featured.openapi(unfeatureRoute, controller.unfeature);
featured.openapi(listRoute, controller.list);
featured.openapi(fileRoute, controller.file);
featured.openapi(featuredByRoute, controller.featuredBy);

export default featured;
