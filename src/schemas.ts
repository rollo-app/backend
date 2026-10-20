import { z } from "@hono/zod-openapi";
import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "./lib/username";
import { isBase64, isEmail, isValidTimeZone } from "./lib/util";

/**
 * API contract. These schemas validate requests, type responses
 * and generate /openapi.json, from which the mobile app generates its client.
 */

const epochMs = (description: string) => z.number().int().positive().openapi({ description, example: 1_767_225_600_000 });
const nullableNumber = z.number().nullable();

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
  })
  .openapi("Member");

// ---------- Auth ----------

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isEmail, "Ingresá un email válido")
  .openapi({ example: "juani@example.com", description: "Trimmed and lowercased" });

export const EmailStartSchema = z.object({ email: emailField }).openapi("EmailStartRequest");

export const EmailVerifySchema = z
  .object({ email: emailField, code: z.string().trim().max(16).openapi({ example: "123456" }) })
  .openapi("EmailVerifyRequest");

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

export const CreateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ example: "Viaje al sur" }),
    timezone: z
      .string()
      .refine(isValidTimeZone, "Zona horaria inválida")
      .openapi({ example: "America/Argentina/Buenos_Aires", description: "IANA time zone of the destination" }),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end; must be after startsAt"),
    revealAt: epochMs("When the roll is revealed; must be >= endsAt"),
    dailyPhotoLimit: z.number().int().min(1).max(100).default(10),
    dailyVideoLimit: z.number().int().min(0).max(20).default(3),
  })
  .refine((d) => d.startsAt >= Date.now() - PAST_TOLERANCE_MS, { message: "El inicio no puede ser en el pasado", path: ["startsAt"] })
  .refine((d) => d.endsAt > d.startsAt, { message: "El rollo tiene que terminar después de empezar", path: ["endsAt"] })
  .refine((d) => d.revealAt >= d.endsAt, { message: "El revelado no puede ser antes del fin", path: ["revealAt"] })
  .openapi("CreateTripRequest");

export const JoinTripSchema = z
  .object({
    code: z.string().trim().toUpperCase().length(6).openapi({ example: "HUB5FT" }),
  })
  .openapi("JoinTripRequest");

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

export const UpdateProfileSchema = z
  .object({ name: personName.optional(), username: usernameField.optional() })
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

export const UpdateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    endsAt: z.number().int().positive().optional().openapi({ description: "Trip end; must be after startsAt and <= the resulting revealAt" }),
    revealAt: z.number().int().positive().optional().openapi({ description: "Must be >= the resulting endsAt" }),
    dailyPhotoLimit: z.number().int().min(1).max(100).optional(),
    dailyVideoLimit: z.number().int().min(0).max(20).optional(),
  })
  .openapi("UpdateTripRequest");

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
  })
  .openapi("TripSummary");

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

// ---------- Media ----------

export const MAX_VIDEO_SECONDS = 15.5; // 15 s + rounding margin
const MB = 1024 * 1024;
export const MAX_SIZE = { photo: 25 * MB, video: 60 * MB } as const;

export const RegisterMediaSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "UUID generated on the phone; retrying with the same id is safe" }),
    type: MediaTypeSchema,
    takenAt: epochMs("Phone time when the shot was taken"),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    accuracyM: z.number().nonnegative().nullish(),
    caption: z.string().trim().max(280).nullish(),
    thumbhash: z
      .string()
      .max(64)
      .refine(isBase64, "El thumbhash tiene que ser base64")
      .nullish()
      .openapi({
        description:
          "ThumbHash (https://evanw.github.io/thumbhash/) in standard base64, generated on the phone from the thumbnail. " +
          "If a retry brings a different value, the first one is kept.",
        example: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
      }),
    durationS: z.number().positive().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    sizeBytes: z.number().int().positive(),
  })
  .refine((d) => d.type !== "video" || (d.durationS != null && d.durationS <= MAX_VIDEO_SECONDS), {
    message: "Los videos tienen que durar 15 segundos o menos",
    path: ["durationS"],
  })
  .refine((d) => d.sizeBytes <= MAX_SIZE[d.type], { message: "El archivo es demasiado grande", path: ["sizeBytes"] })
  .openapi("RegisterMediaRequest");

export const MediaRegisteredSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal("pending"),
    upload: z.object({
      original: z.string().url().openapi({ description: "PUT of the original file" }),
      thumb: z.string().url().openapi({ description: "PUT of the JPEG thumbnail (~800px)" }),
    }),
    expiresIn: z.number().int().openapi({ description: "Seconds the URLs stay valid" }),
  })
  .openapi("MediaRegistered");

export const MediaStatusSchema = z
  .object({ id: z.string().uuid(), status: z.literal("uploaded") })
  .openapi("MediaStatus");

export const FeedItemSchema = z
  .object({
    id: z.string().uuid(),
    type: MediaTypeSchema,
    takenAt: z.number().int(),
    day: z.string().openapi({ example: "2027-01-12" }),
    lat: nullableNumber,
    lng: nullableNumber,
    caption: z.string().nullable(),
    thumbhash: z.string().nullable().openapi({
      description:
        "ThumbHash in base64. Always returned, also before the reveal, on purpose: " +
        "it only encodes blurry colors (~25 bytes), the photo cannot be reconstructed from it.",
    }),
    durationS: nullableNumber,
    author: z
      .object({ id: z.string().uuid(), name: z.string(), username: z.string().nullable(), avatarUrl: z.string().nullable() })
      .openapi({ description: "`id` is the author's membership id" }),
    width: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    height: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    files: z
      .object({ thumb: z.string(), original: z.string() })
      .optional()
      .openapi({ description: "Download paths; only after the reveal" }),
  })
  .openapi("FeedItem");

export const FeedResponseSchema = z
  .object({
    revealed: z.boolean(),
    revealAt: z.number().int(),
    items: z.array(FeedItemSchema),
  })
  .openapi("Feed");

// ---------- Path params ----------

const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const TripParams = z.object({ tripId: pathParam("tripId") });
export const TripMemberParams = z.object({ tripId: pathParam("tripId"), memberId: pathParam("memberId") });
export const MediaParams = z.object({ mediaId: pathParam("mediaId") });
export const MediaFileParams = z.object({
  tripId: pathParam("tripId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
