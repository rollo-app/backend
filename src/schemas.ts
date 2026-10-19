import { z } from "@hono/zod-openapi";
import { isBase64, isValidTimeZone } from "./lib/util";

/**
 * Contrato de la API. Estos esquemas validan los requests, tipan las respuestas
 * y generan /openapi.json, del que la app mobile genera su cliente.
 */

const epochMs = (description: string) => z.number().int().positive().openapi({ description, example: 1_767_225_600_000 });
const nullableNumber = z.number().nullable();

// ---------- Comunes ----------

export const ErrorSchema = z
  .object({ error: z.string().openapi({ example: "Código inválido" }) })
  .openapi("Error");

export const RoleSchema = z.enum(["admin", "member"]).openapi("Role");
export const MediaTypeSchema = z.enum(["photo", "video"]).openapi("MediaType");

export const TripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: "Viaje al sur" }),
    joinCode: z.string().openapi({ example: "HUB5FT", description: "Código de 6 caracteres para unirse" }),
    timezone: z.string().openapi({ example: "America/Argentina/Buenos_Aires" }),
    startsAt: epochMs("Inicio del viaje"),
    endsAt: epochMs("Fin del viaje"),
    revealAt: epochMs("Revelado automático"),
    revealed: z.boolean(),
    dailyPhotoLimit: z.number().int(),
    dailyVideoLimit: z.number().int(),
  })
  .openapi("Trip");

export const MemberSchema = z
  .object({ id: z.string().uuid(), name: z.string().openapi({ example: "Fede" }), role: RoleSchema })
  .openapi("Member");

// ---------- Viajes ----------

const personName = z.string().trim().min(1).max(30).openapi({ example: "Juani" });

export const CreateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ example: "Viaje al sur" }),
    adminName: personName,
    timezone: z
      .string()
      .refine(isValidTimeZone, "zona horaria inválida")
      .openapi({ example: "America/Argentina/Buenos_Aires", description: "Zona IANA del destino" }),
    startsAt: epochMs("Inicio del viaje"),
    endsAt: epochMs("Fin del viaje"),
    revealAt: epochMs("Cuándo se revela el rollo"),
    dailyPhotoLimit: z.number().int().min(1).max(100).default(10),
    dailyVideoLimit: z.number().int().min(0).max(20).default(3),
  })
  .refine((d) => d.endsAt > d.startsAt, { message: "el viaje tiene que terminar después de empezar", path: ["endsAt"] })
  .refine((d) => d.revealAt >= d.startsAt, { message: "el revelado no puede ser antes del inicio", path: ["revealAt"] })
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
    endsAt: z.number().int().positive().optional(),
    revealAt: z.number().int().positive().optional(),
    dailyPhotoLimit: z.number().int().min(1).max(100).optional(),
    dailyVideoLimit: z.number().int().min(0).max(20).optional(),
  })
  .openapi("UpdateTripRequest");

export const TripCreatedSchema = z
  .object({
    trip: TripSchema,
    member: MemberSchema,
    token: z.string().openapi({ description: "Guardalo en el celular: es la única vez que se devuelve" }),
  })
  .openapi("TripCreated");

export const TripDetailSchema = z
  .object({
    trip: TripSchema,
    me: MemberSchema,
    members: z.array(MemberSchema),
    today: z.object({
      date: z.string().openapi({ example: "2027-01-12", description: "Fecha local del viaje" }),
      photosLeft: z.number().int(),
      videosLeft: z.number().int(),
    }),
    totalUploaded: z.number().int(),
  })
  .openapi("TripDetail");

export const TripResponseSchema = z.object({ trip: TripSchema }).openapi("TripResponse");

// ---------- Media ----------

export const MAX_VIDEO_SECONDS = 15.5; // 15 s + margen de redondeo
const MB = 1024 * 1024;
export const MAX_SIZE = { photo: 25 * MB, video: 60 * MB } as const;

export const RegisterMediaSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "UUID generado en el celular; reintentar con el mismo id es seguro" }),
    type: MediaTypeSchema,
    takenAt: epochMs("Hora del celular al disparar"),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    accuracyM: z.number().nonnegative().nullish(),
    caption: z.string().trim().max(280).nullish(),
    thumbhash: z
      .string()
      .max(64)
      .refine(isBase64, "thumbhash tiene que ser base64")
      .nullish()
      .openapi({
        description:
          "ThumbHash (https://evanw.github.io/thumbhash/) en base64 estándar, generado en el celular desde el thumbnail. " +
          "Si un reintento trae otro valor, se conserva el primero.",
        example: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
      }),
    durationS: z.number().positive().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    sizeBytes: z.number().int().positive(),
  })
  .refine((d) => d.type !== "video" || (d.durationS != null && d.durationS <= MAX_VIDEO_SECONDS), {
    message: "los videos tienen que durar 15 segundos o menos",
    path: ["durationS"],
  })
  .refine((d) => d.sizeBytes <= MAX_SIZE[d.type], { message: "archivo demasiado grande", path: ["sizeBytes"] })
  .openapi("RegisterMediaRequest");

export const MediaRegisteredSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal("pending"),
    upload: z.object({
      original: z.string().url().openapi({ description: "PUT del archivo original" }),
      thumb: z.string().url().openapi({ description: "PUT del thumbnail JPEG (~800px)" }),
    }),
    expiresIn: z.number().int().openapi({ description: "Segundos de validez de las URLs" }),
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
        "ThumbHash en base64. Se devuelve siempre, también antes del revelado, a propósito: " +
        "solo codifica colores difusos (~25 bytes), no deja reconstruir la foto.",
    }),
    durationS: nullableNumber,
    author: z.object({ id: z.string().uuid(), name: z.string() }),
    width: nullableNumber.optional().openapi({ description: "Solo después del revelado" }),
    height: nullableNumber.optional().openapi({ description: "Solo después del revelado" }),
    files: z
      .object({ thumb: z.string(), original: z.string() })
      .optional()
      .openapi({ description: "Paths de descarga; solo después del revelado" }),
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
