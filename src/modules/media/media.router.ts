import { createRoute, z } from "@hono/zod-openapi";
import { requireAdmin, requireMediaMember, requireTripMember, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { MediaParams, TripParams } from "../../schemas";
import * as controller from "./media.controller";
import {
  FeedResponseSchema,
  MediaFileParams,
  MediaRegisteredSchema,
  MediaStatusSchema,
  RegisterMediaSchema,
} from "./media.schemas";

const tags = ["Media"];

// ---------- Register ----------

export const registerRoute = createRoute({
  method: "post",
  path: "/trips/{tripId}/media",
  tags,
  summary: "Register a photo or video",
  description:
    "Returns signed URLs to upload the original and the thumbnail straight to R2; each is signed for the exact byte size declared (`sizeBytes`, `thumbSizeBytes`). " +
    "Idempotent by `id`: retrying from the offline queue neither duplicates nor spends quota.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: RegisterMediaSchema } }, required: true },
  },
  responses: {
    201: json(MediaRegisteredSchema, "Registered; upload the files"),
    200: json(z.union([MediaRegisteredSchema, MediaStatusSchema]), "Retry: new URLs, or it was already uploaded"),
    ...errors(400, 401, 403, 409, 429),
  },
});

// ---------- Confirm upload ----------

export const completeRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/complete",
  tags,
  summary: "Confirm the files were uploaded",
  description:
    "Checks that the original and the thumbnail are in R2 and that their sizes match what was registered. " +
    "Only then does the photo show up in the feed. On a size mismatch both files are deleted and the media stays pending (register again for new URLs).",
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 200: json(MediaStatusSchema, "Upload confirmed"), ...errors(400, 401, 404) },
});

// ---------- Feed ----------

export const feedRoute = createRoute({
  method: "get",
  path: "/trips/{tripId}/feed",
  tags,
  summary: "Trip feed",
  description:
    "Before the reveal: metadata only (author, time, place, caption, thumbhash), no files, not even your own. " +
    "After: includes dimensions, the download paths, whether you featured each photo, whether its author blocked featuring, " +
    "and its likes (`likeCount`, `likedByMe`). " +
    "Every item carries the author's user id (`author.userId`). Photos you reported and photos by people you blocked are left out.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 200: json(FeedResponseSchema, "Feed ordered by the time the shot was taken"), ...errors(401, 403) },
});

// ---------- Download ----------

export const downloadRoute = createRoute({
  method: "get",
  path: "/trips/{tripId}/media/{mediaId}/{variant}",
  tags,
  summary: "Download a file (only after the reveal)",
  description: "Streamed from R2 with the same Bearer token.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: MediaFileParams },
  responses: {
    200: {
      description: "File",
      content: {
        "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
        "video/mp4": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...errors(401, 403, 404),
  },
});

// ---------- Delete ----------

export const deleteRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}",
  tags,
  summary: "Delete a photo or video from the trip (admin, before the reveal)",
  description:
    "Once sent, a photo can be neither deleted nor retaken. The exception is the admin, in case someone " +
    "sends something inappropriate: they can delete any photo of the trip before the reveal. " +
    "The files are deleted but the quota is **not given back** to anyone, and the id cannot be registered again.",
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember, requireAdmin] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404, 409) },
});

// ---------- Feature block (author) ----------

export const blockFeatureRoute = createRoute({
  method: "put",
  path: "/media/{mediaId}/feature-block",
  tags,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Done" }, ...errors(401, 403, 404) },
  summary: "Don't let others feature this photo (author only)",
  description:
    "Removes it from everyone else's profile and stops new ones (they get 409). You can still feature it yourself. " +
    "Idempotent. Works even if you left the rollo or were removed from it. " +
    "403 if you did not take it; 404 if it does not exist or you neither took it nor are an active member of its rollo.",
});

export const unblockFeatureRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}/feature-block",
  tags,
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Done" }, ...errors(401, 403, 404) },
  summary: "Let others feature this photo again (author only)",
  description:
    "Idempotent. Works even if you left the rollo or were removed from it. " +
    "Photos removed from other profiles while it was blocked do not come back.",
});

const media = createApp();

media.openapi(registerRoute, controller.register);
media.openapi(completeRoute, controller.complete);
media.openapi(feedRoute, controller.feed);
media.openapi(downloadRoute, controller.download);
media.openapi(deleteRoute, controller.remove);
media.openapi(blockFeatureRoute, controller.blockFeature);
media.openapi(unblockFeatureRoute, controller.unblockFeature);

export default media;
