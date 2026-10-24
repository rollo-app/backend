import { z } from "@hono/zod-openapi";
import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "./lib/username";
import { isEmail } from "./lib/util";

/**
 * API contract. These schemas validate requests, type responses
 * and generate /openapi.json, from which the mobile app generates its client.
 */

export const epochMs = (description: string) => z.number().int().positive().openapi({ description, example: 1_767_225_600_000 });
export const nullableNumber = z.number().nullable();

// ---------- Common ----------

export const ErrorSchema = z
  .object({ error: z.string().openapi({ example: "Código inválido" }) })
  .openapi("Error");

export const RoleSchema = z.enum(["admin", "member"]).openapi("Role");
export const MediaTypeSchema = z.enum(["photo", "video"]).openapi("MediaType");

export const TripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: "Viaje al sur" }),
    joinCode: z.string().openapi({ example: "HUB5FT", description: "6-character code to join" }),
    timezone: z.string().openapi({ example: "America/Argentina/Buenos_Aires" }),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end"),
    revealAt: epochMs("Automatic reveal"),
    revealed: z.boolean(),
    dailyPhotoLimit: z.number().int(),
    dailyVideoLimit: z.number().int(),
  })
  .openapi("Trip");

export const ProfileVisibilitySchema = z.enum(["friends", "public"]).openapi("ProfileVisibility", {
  description: "Who can see your bio and featured photos: your friends only, or anyone signed in. Name, username and avatar are always visible",
});

export const UserBadgeSchema = z.enum(["founder", "first_edition"]).nullable().openapi({
  description: "Profile badge assigned by hand (founder = Founder, first_edition = First Edition); null if none",
});

export const UserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().openapi({ example: "juani@example.com" }),
    name: z.string().nullable().openapi({ description: "null until the profile is completed" }),
    username: z.string().nullable().openapi({
      example: "juanifraga",
      description: "Unique handle, lowercase, without the @ (the app shows it as @username); null until chosen",
    }),
    avatarUrl: z.string().nullable().openapi({
      description: "Path (the app prefixes the API base URL), e.g. /avatars/<userId>/<version>.jpg; null if none",
    }),
    bio: z.string().nullable().openapi({ example: "Viajando por el sur", description: "Profile description (up to 3 lines); null if none" }),
    badge: UserBadgeSchema,
    profileVisibility: ProfileVisibilitySchema,
  })
  .openapi("User");

export const MemberSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Membership id (the one used by DELETE members and FeedItem.author)" }),
    userId: z.string().uuid(),
    name: z.string().openapi({ example: "Fede" }),
    username: z.string().nullable().openapi({ example: "fede", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
    role: RoleSchema,
    blockedByMe: z.boolean().openapi({ description: "Whether you blocked this member" }),
  })
  .openapi("Member");

// ---------- Auth ----------

export const AuthSessionSchema = z
  .object({
    token: z.string().openapi({ description: "Session token (Bearer). Valid for 365 days; store it on the phone" }),
    user: UserSchema,
    isNew: z.boolean().openapi({ description: "true while the profile is incomplete (no name or no username): show the profile step" }),
  })
  .openapi("AuthSession");

// ---------- Trips ----------

const personName = z.string().trim().min(1).max(30).openapi({ example: "Juani" });

/** Clock-skew tolerance when validating that a date is not in the past. */
export const PAST_TOLERANCE_MS = 5 * 60_000;

/** Accepts it with or without "@" and any case; the parsed value is the normalized one. */
export const usernameField = z
  .string()
  .transform(normalizeUsername)
  .refine(isValidUsername, USERNAME_INVALID_MESSAGE)
  .openapi({
    type: "string",
    example: "juanifraga",
    description: "Optional leading @, trimmed and lowercased. a-z 0-9 . _ (3 to 30), no leading/trailing dot, no \"..\"",
  });

export const BIO_MAX_LENGTH = 150;
export const BIO_MAX_LINES = 3;

/** Trimmed; an empty bio is stored as null. A CRLF (or a lone CR) counts as one line break. */
export const bioField = z
  .string()
  .trim()
  .refine((s) => s.length <= BIO_MAX_LENGTH, `La descripción puede tener hasta ${BIO_MAX_LENGTH} caracteres`)
  .refine((s) => s.split(/\r\n|\r|\n/).length <= BIO_MAX_LINES, `La descripción puede tener hasta ${BIO_MAX_LINES} renglones`)
  .transform((s) => (s === "" ? null : s))
  .openapi({
    type: "string",
    example: "Viajando por el sur",
    description: `Profile description, up to ${BIO_MAX_LENGTH} characters and ${BIO_MAX_LINES} lines after trimming. An empty string clears it`,
  });

export const UpdateProfileSchema = z
  .object({
    name: personName.optional(),
    username: usernameField.optional(),
    bio: bioField.optional(),
    profileVisibility: ProfileVisibilitySchema.optional(),
  })
  .openapi("UpdateProfileRequest");

export const UsernameParams = z.object({
  username: z.string().openapi({ param: { name: "username", in: "path" }, example: "juanifraga" }),
});

export const UsernameAvailabilitySchema = z
  .object({
    available: z.boolean().openapi({ description: "true if nobody else has it (also true if it is yours)" }),
    username: z.string().openapi({ description: "The normalized username that was checked" }),
  })
  .openapi("UsernameAvailability");

export const TripCreatedSchema = z
  .object({
    trip: TripSchema,
    member: MemberSchema,
  })
  .openapi("TripCreated");

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
    totalUploaded: z.number().int(),
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

export const AvatarParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
  file: z.string().openapi({ param: { name: "file", in: "path" }, example: "3f1c2a.jpg" }),
});

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
  })
  .openapi("NotificationSettings");

export const UserSettingsSchema = z.object({ notifications: NotificationSettingsSchema }).openapi("UserSettings");

export const UpdateUserSettingsSchema = z
  .strictObject({ notifications: NotificationSettingsSchema.partial().strict().optional() })
  .openapi("UpdateUserSettingsRequest");

export const MyTripsSchema = z.object({ trips: z.array(TripSummarySchema) }).openapi("MyTrips");

export const TripDetailSchema = z
  .object({
    trip: TripSchema,
    me: MemberSchema,
    members: z.array(MemberSchema),
    today: z.object({
      date: z.string().openapi({ example: "2027-01-12", description: "Trip's local date" }),
      photosLeft: z.number().int().openapi({ description: "0 outside the rollo's dates" }),
      videosLeft: z.number().int().openapi({ description: "0 outside the rollo's dates" }),
    }),
    totalUploaded: z.number().int(),
  })
  .openapi("TripDetail");

export const TripResponseSchema = z.object({ trip: TripSchema }).openapi("TripResponse");

// ---------- Friends ----------

export const FriendSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "User id" }),
    name: z.string().openapi({ example: "Cami" }),
    username: z.string().nullable().openapi({ example: "cami", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable().openapi({ example: "Viajando por el sur", description: "Profile description (up to 3 lines); null if none" }),
  })
  .openapi("Friend");

export const BlocksSchema = z.object({ blocked: z.array(FriendSchema) }).openapi("Blocks");

export const ReportReasonSchema = z.enum(["offensive", "abuse", "other"]).openapi("ReportReason");

export const CreateReportSchema = z
  .object({
    reason: ReportReasonSchema,
    mediaId: z.string().trim().min(1).max(64).optional().openapi({ description: "Photo or video to report" }),
    userId: z.string().trim().min(1).max(64).optional().openapi({ description: "Person to report" }),
  })
  .refine((b) => (b.mediaId !== undefined) !== (b.userId !== undefined), "Mandá la foto o la persona, no las dos")
  .openapi("CreateReportRequest");

// ---------- Users ----------

export const UserParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});


export const FriendParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});

// ---------- Featured photos ----------

export const MAX_FEATURED = 60;

export const ZoneSchema = z
  .object({ lat: z.number(), lng: z.number() })
  .openapi("Zone", {
    description: "Center of the ~5 km cell (0.05°) where the photo was taken. Never the exact coordinates",
    example: { lat: -41.075, lng: -71.475 },
  });

export const FeaturedPhotoSchema = z
  .object({
    mediaId: z.string().uuid(),
    takenAt: z.number().int(),
    width: nullableNumber,
    height: nullableNumber,
    thumbhash: z.string().nullable(),
    author: z
      .object({
        id: z.string().uuid().openapi({ description: "User id" }),
        name: z.string(),
        username: z.string().nullable(),
        avatarUrl: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "Who took it; null when it is the profile owner" }),
    zone: ZoneSchema.nullable().openapi({ description: "null if the photo has no GPS" }),
    thumbPath: z.string().openapi({ example: "/featured/<userId>/<mediaId>/thumb" }),
    originalPath: z.string().openapi({ example: "/featured/<userId>/<mediaId>/original" }),
    likeCount: z.number().int().openapi({ description: "How many people like it (the same counter as in its rollo)" }),
    likedByMe: z.boolean().openapi({ description: "You like it" }),
  })
  .openapi("FeaturedPhoto", {
    description: "A photo on someone's profile. Never includes the rollo, the caption or the exact location",
  });

export const FeaturedPhotosSchema = z
  .object({ photos: z.array(FeaturedPhotoSchema).openapi({ description: "Most recently featured first" }) })
  .openapi("FeaturedPhotos");

// ---------- Path params ----------

export const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const TripParams = z.object({ tripId: pathParam("tripId") });
export const MediaParams = z.object({ mediaId: pathParam("mediaId") });
export const FeaturedFileParams = z.object({
  userId: pathParam("userId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
