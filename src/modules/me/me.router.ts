import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { UpdateProfileSchema, UserSchema } from "../../schemas";
import * as controller from "./me.controller";
import {
  AvatarUploadRequestSchema,
  AvatarUploadSchema,
  MyTripsSchema,
  PushTokenParams,
  UpdateUserSettingsSchema,
  UserSettingsSchema,
} from "./me.schemas";

const tags = ["Profile"];

export const getMeRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Your profile",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSchema, "Your profile"), ...errors(401) },
});

export const updateMeRoute = createRoute({
  method: "patch",
  path: "/",
  tags,
  summary: "Edit your profile",
  description:
    "Send any of name, username, bio and profileVisibility; fields left out are not changed. The name is shown in every rollo you are part of and does not have to be unique. " +
    "The username must be unique (case-insensitive); setting your own current one is a no-op. 409 if someone else has it. " +
    "The bio is trimmed, an empty one clears it (null), and it allows up to 150 characters and 3 lines (400 otherwise). " +
    "profileVisibility is \"friends\" (default) or \"public\"; any other value is a 400.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: UpdateProfileSchema } }, required: true } },
  responses: { 200: json(UserSchema, "Profile updated"), ...errors(400, 401, 409) },
});

export const avatarRoute = createRoute({
  method: "post",
  path: "/avatar",
  tags,
  summary: "Get a URL to upload your avatar",
  description:
    "Send the exact byte size of the JPEG (`sizeBytes`, max 2 MB; 400 otherwise). Returns a URL signed for exactly that Content-Length to PUT the JPEG straight to R2. Then call POST /me/avatar/complete. " +
    "503 when the storage limit is reached. A previous upload that was never completed is discarded. " +
    "Each call generates a new random file name, so the avatar URL changes when you replace it.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE")] as const,
  request: { body: { content: { "application/json": { schema: AvatarUploadRequestSchema } }, required: true } },
  responses: { 200: json(AvatarUploadSchema, "Upload URL"), ...errors(400, 401, 429, 503) },
});

export const avatarCompleteRoute = createRoute({
  method: "post",
  path: "/avatar/complete",
  tags,
  summary: "Confirm your avatar upload",
  description:
    "Checks that the file is in R2, is a JPEG (verified by its magic bytes) and is at most 2 MB, " +
    "makes it your avatar and deletes the previous one. Otherwise the upload is discarded and the response is a 400.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE")] as const,
  responses: { 200: json(UserSchema, "Profile with the new avatar"), ...errors(400, 401, 429) },
});

export const deleteMeRoute = createRoute({
  method: "delete",
  path: "/",
  tags,
  summary: "Delete your account",
  description:
    "Permanently deletes the account. In every rollo you belong to (also those you were removed from), " +
    "your photos and videos are deleted (database rows and files, even after the reveal) and your membership is removed. " +
    "If you were the admin, the oldest remaining active member becomes admin. " +
    "If no active members remain, the whole rollo is deleted with all its files. " +
    "Your reports and blocks (made and received), push tokens, settings and likes (yours, and the ones on your photos) are deleted too. Your friendships, friend links and claims, avatar, sessions and pending login codes are deleted too (your friends keep their rollos). " +
    "The same email can sign up again later as a brand-new user.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 204: { description: "Account deleted" }, ...errors(401) },
});

export const myTripsRoute = createRoute({
  method: "get",
  path: "/trips",
  tags,
  summary: "Your rollos",
  description: "Rollos you are an active member of, most recent start first.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(MyTripsSchema, "Your rollos"), ...errors(401) },
});

export const putPushTokenRoute = createRoute({
  method: "put",
  path: "/push-tokens/{token}",
  tags: ["Notifications"],
  summary: "Register this phone's push token",
  description:
    "Registers an Expo push token (ExponentPushToken[...] or ExpoPushToken[...], URL-encoded in the path) for your account. " +
    "Idempotent: calling it again only refreshes when it was last seen. A token belongs to one account at a time: " +
    "if another account had it (same phone, another account), it moves to yours. 400 if it is not an Expo push token.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: PushTokenParams },
  responses: { 204: { description: "Token registered" }, ...errors(400, 401) },
});

export const deletePushTokenRoute = createRoute({
  method: "delete",
  path: "/push-tokens/{token}",
  tags: ["Notifications"],
  summary: "Unregister a push token",
  description: "Stops sending pushes to this token for your account (call it when signing out). Idempotent; another account's token is left alone.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: PushTokenParams },
  responses: { 204: { description: "Token removed" }, ...errors(400, 401) },
});

export const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings",
  tags: ["Notifications"],
  summary: "Your settings",
  description: "Your notification preferences, one per kind of push. Every one is on by default.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSettingsSchema, "Your settings"), ...errors(401) },
});

export const updateSettingsRoute = createRoute({
  method: "patch",
  path: "/settings",
  tags: ["Notifications"],
  summary: "Change your settings",
  description:
    "Send any subset of the notification preferences; the ones left out do not change. " +
    "Unknown keys or non-boolean values are a 400. Returns the full settings.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: UpdateUserSettingsSchema } }, required: true } },
  responses: { 200: json(UserSettingsSchema, "Settings updated"), ...errors(400, 401) },
});

const me = createApp();

me.openapi(getMeRoute, controller.getMe);
me.openapi(updateMeRoute, controller.updateMe);
me.openapi(avatarRoute, controller.requestAvatar);
me.openapi(avatarCompleteRoute, controller.completeAvatar);
me.openapi(deleteMeRoute, controller.deleteMe);
me.openapi(myTripsRoute, controller.myTrips);
me.openapi(putPushTokenRoute, controller.putPushToken);
me.openapi(deletePushTokenRoute, controller.deletePushToken);
me.openapi(getSettingsRoute, controller.getSettings);
me.openapi(updateSettingsRoute, controller.updateSettings);

export default me;
