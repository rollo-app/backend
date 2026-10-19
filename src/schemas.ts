import { z } from "@hono/zod-openapi";
import { isBase64, isValidTimeZone } from "./lib/util";

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

export const MemberSchema = z
  .object({ id: z.string().uuid(), name: z.string().openapi({ example: "Fede" }), role: RoleSchema })
  .openapi("Member");

// ---------- Trips ----------

const personName = z.string().trim().min(1).max(30).openapi({ example: "Juani" });

/** Clock-skew tolerance when validating that a date is not in the past. */
export const PAST_TOLERANCE_MS = 5 * 60_000;

export const CreateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ example: "Viaje al sur" }),
    adminName: personName,
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
    name: personName,
  })
  .openapi("JoinTripRequest");

export const UpdateMeSchema = z.object({ name: personName }).openapi("UpdateMeRequest");

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
    token: z.string().openapi({ description: "Store it on the phone: it is only returned once" }),
  })
  .openapi("TripCreated");

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
    author: z.object({ id: z.string().uuid(), name: z.string() }),
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
