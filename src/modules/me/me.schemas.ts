import { z } from "@hono/zod-openapi";
import { epochMs, RoleSchema } from "../../schemas";

export const TripSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    joinCode: z.string(),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end"),
    revealAt: epochMs("Automatic reveal"),
    revealed: z.boolean(),
    role: RoleSchema,
    isCreator: z.boolean().openapi({ description: "You created this rollo" }),
    archived: z.boolean().openapi({ description: "You archived this rollo (only for you)" }),
    totalUploaded: z.number().int(),
    momentMode: z.enum(["off", "photo", "photo_selfie"]).openapi({ description: "Daily moment: off, a photo, or a photo plus a selfie" }),
    coverThumbhash: z.string().nullable().openapi({
      description:
        "ThumbHash of the most recently taken uploaded photo or video of the rollo (null if none); the app derives the rollo's color from it",
    }),
  })
  .openapi("TripSummary");

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AvatarUploadRequestSchema = z
  .object({
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(AVATAR_MAX_BYTES, "La foto tiene que ser un JPEG de hasta 2 MB")
      .openapi({ description: "Exact byte size of the JPEG (max 2 MB); the upload URL is signed for exactly this Content-Length" }),
  })
  .openapi("AvatarUploadRequest");

export const AvatarUploadSchema = z
  .object({
    upload: z.string().url().openapi({ description: "PUT of the JPEG avatar (square, ~512px)" }),
    expiresIn: z.number().int().openapi({ description: "Seconds the URL stays valid" }),
  })
  .openapi("AvatarUpload");

// ---------- Push tokens and settings ----------

/** Expo push token as returned by getExpoPushTokenAsync. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export const PushTokenParams = z.object({
  token: z
    .string()
    .max(200, "El token de notificaciones no es válido")
    .regex(EXPO_PUSH_TOKEN, "El token de notificaciones no es válido")
    .openapi({ param: { name: "token", in: "path" }, example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" }),
});

export const NotificationSettingsSchema = z
  .object({
    addedToTrip: z.boolean().openapi({ description: "Someone adds you to a rollo" }),
    newFriend: z.boolean().openapi({ description: "Someone redeems your friend link" }),
    tripStarted: z.boolean().openapi({ description: "A rollo you are in starts" }),
    tripRevealed: z.boolean().openapi({ description: "A rollo you are in is revealed" }),
    photoFeatured: z.boolean().openapi({ description: "Someone features a photo of yours on their profile" }),
    photoLiked: z.boolean().openapi({ description: "Someone likes a photo of yours" }),
    photoCommented: z.boolean().openapi({ description: "Someone comments on a photo of yours, or on one you commented on" }),
    friendRequest: z.boolean().openapi({ description: "Someone sends you a friend request" }),
    dailyMoment: z.boolean().openapi({ description: "It is your moment of the day in a rollo with the daily moment on" }),
    momentPosted: z.boolean().openapi({ description: "Someone in a rollo you are in uploaded their daily moment" }),
  })
  .openapi("NotificationSettings");

export const PrivacySettingsSchema = z
  .object({
    allowFeaturing: z.boolean().openapi({ description: "Others may feature any of your photos on their profile (on by default)" }),
  })
  .openapi("PrivacySettings");

export const UserSettingsSchema = z
  .object({ notifications: NotificationSettingsSchema, privacy: PrivacySettingsSchema })
  .openapi("UserSettings");

export const UpdateUserSettingsSchema = z
  .strictObject({
    notifications: NotificationSettingsSchema.partial().strict().optional(),
    privacy: PrivacySettingsSchema.partial().strict().optional(),
  })
  .openapi("UpdateUserSettingsRequest");

export const MyTripsSchema = z.object({ trips: z.array(TripSummarySchema) }).openapi("MyTrips");
