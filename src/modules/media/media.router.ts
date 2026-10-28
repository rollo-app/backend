import { createRoute, z } from "@hono/zod-openapi";
import { requireMediaMember, requireTripMember, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
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
    "Idempotent by `id`: retrying from the offline queue neither duplicates nor spends quota. " +
    "503 when the storage limit is reached (new registrations only, never retries).",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: RegisterMediaSchema } }, required: true },
  },
  responses: {
    201: json(MediaRegisteredSchema, "Registered; upload the files"),
    200: json(z.union([MediaRegisteredSchema, MediaStatusSchema]), "Retry: new URLs, or it was already uploaded"),
    ...errors(400, 401, 403, 409, 410, 429, 503),
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
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 200: json(MediaStatusSchema, "Upload confirmed"), ...errors(400, 401, 404, 429) },
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
    "and its likes (`likeCount`, `likedByMe`) and comments (`commentCount`; before the reveal only a daily moment's photo has `commentCount`). " +
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
  summary: "Download a file (only after the reveal, except daily moment photos)",
  description: "Streamed from R2 with the same Bearer token. Before the reveal only the two images of a daily moment (main and linked) can be fetched, by active members; anything else is 403.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_FILES"), requireTripMember] as const,
  request: { params: MediaFileParams },
  responses: {
    200: {
      description: "File",
      content: {
        "image/jpeg": { schema: z.string().openapi({ format: "binary" }) },
        "video/mp4": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    ...errors(401, 403, 404, 429),
  },
});

// ---------- Delete ----------

export const deleteRoute = createRoute({
  method: "delete",
  path: "/media/{mediaId}",
  tags,
  summary: "Delete a photo or video: the admin before the reveal, the author after it",
  description:
    "**Before the reveal** only the admin can delete (in case someone sends something inappropriate): any photo or video of the trip; " +
    "anyone else gets 403. The files are deleted but the quota is **not given back** to anyone, and the id cannot be registered again. " +
    "**After the reveal** only the author can delete their own photo or video, for good: it disappears for everyone, with its files, " +
    "likes, comments and every profile that featured it. Another member gets 403 (the admin 409, as before). " +
    "Deleting a daily moment's main photo deletes its linked image too; the linked image's own id is 400.",
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Deleted" }, ...errors(400, 401, 403, 404, 409) },
});

// ---------- Archive (author, after the reveal) ----------

const archiveDescription =
  "Author only (photos and videos), once the rollo is revealed, and while you are an active member (else 404). " +
  "Another member gets 403; before the reveal 409. A daily moment's main photo takes its linked image along; " +
  "the linked image's own id is 400. Idempotent.";

export const archiveRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/archive",
  tags,
  summary: "Archive your photo: only you keep seeing it",
  description:
    "It disappears for everyone else everywhere (feed, downloads, likes, comments, \"Tu actividad\", profiles), right away. " +
    "It leaves every profile where it was featured, yours included, and unarchiving does not put it back. " +
    "In your own feed it comes with `archived: true`. " +
    archiveDescription,
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Archived" }, ...errors(400, 401, 403, 404, 409) },
});

export const unarchiveRoute = createRoute({
  method: "post",
  path: "/media/{mediaId}/unarchive",
  tags,
  summary: "Unarchive your photo: everyone sees it again",
  description: "It is not featured again anywhere (it can be featured again). " + archiveDescription,
  security: bearerAuth,
  middleware: [requireUser, requireMediaMember] as const,
  request: { params: MediaParams },
  responses: { 204: { description: "Unarchived" }, ...errors(400, 401, 403, 404, 409) },
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
media.openapi(archiveRoute, controller.archive);
media.openapi(unarchiveRoute, controller.unarchive);
media.openapi(blockFeatureRoute, controller.blockFeature);
media.openapi(unblockFeatureRoute, controller.unblockFeature);

export default media;
