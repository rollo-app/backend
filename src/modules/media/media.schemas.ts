import { z } from "@hono/zod-openapi";
import { isBase64 } from "../../lib/util";
import { epochMs, MediaTypeSchema, nullableNumber } from "../../schemas";

export const MAX_VIDEO_SECONDS = 15.5; // 15 s + rounding margin
const MB = 1024 * 1024;
export const MAX_SIZE = { photo: 12 * MB, video: 30 * MB } as const;
export const MAX_THUMB_SIZE = 2 * MB;

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
    sizeBytes: z.number().int().positive().openapi({
      description: "Exact byte size of the original file; the upload URL is signed for exactly this Content-Length",
    }),
    thumbSizeBytes: z.number().int().positive().openapi({
      description: "Exact byte size of the thumbnail JPEG; the upload URL is signed for exactly this Content-Length",
    }),
    momentDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish()
      .openapi({
        description:
          "Trip-local date (YYYY-MM-DD) of the daily moment this photo answers. The member must have a moment for that day " +
          "(409 otherwise, or if it already has a photo). Moment photos don't use the photo quota. Photos only.",
        example: "2027-01-12",
      }),
    pairedMediaId: z.string().uuid().nullish().openapi({
      description:
        "Marks this photo as the selfie of a moment: the id of the member's own moment photo in the same rollo (400 otherwise). " +
        "The selfie takes its moment day from that photo and doesn't use the photo quota.",
    }),
  })
  .refine((d) => d.type !== "video" || (d.durationS != null && d.durationS <= MAX_VIDEO_SECONDS), {
    message: "Los videos tienen que durar 15 segundos o menos",
    path: ["durationS"],
  })
  .refine((d) => d.type === "photo" || (d.momentDay == null && d.pairedMediaId == null), {
    message: "Solo las fotos pueden ser del momento del día",
    path: ["momentDay"],
  })
  .refine((d) => d.sizeBytes <= MAX_SIZE[d.type], { message: "El archivo es demasiado grande", path: ["sizeBytes"] })
  .refine((d) => d.thumbSizeBytes <= MAX_THUMB_SIZE, {
    message: "El thumbnail es demasiado grande",
    path: ["thumbSizeBytes"],
  })
  .openapi("RegisterMediaRequest");

export type RegisterMediaInput = z.infer<typeof RegisterMediaSchema>;

export const MediaRegisteredSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal("pending"),
    upload: z.object({
      original: z.string().url().openapi({ description: "PUT of the original file; send exactly `sizeBytes` bytes as Content-Length" }),
      thumb: z.string().url().openapi({ description: "PUT of the JPEG thumbnail (~800px); send exactly `thumbSizeBytes` bytes as Content-Length" }),
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
      .object({
        id: z.string().uuid(),
        userId: z.string().uuid().openapi({ description: "The author's user id (to open their profile)" }),
        name: z.string(),
        username: z.string().nullable(),
        avatarUrl: z.string().nullable(),
      })
      .openapi({ description: "`id` is the author's membership id; `userId` their user id" }),
    width: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    height: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    files: z
      .object({ thumb: z.string(), original: z.string() })
      .optional()
      .openapi({ description: "Download paths; only after the reveal" }),
    featuredByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you featured it on your profile" }),
    featureBlocked: z.boolean().optional().openapi({
      description: "Only after the reveal: the author does not let others feature it (they still can)",
    }),
    canFeature: z.boolean().optional().openapi({
      description:
        "Only after the reveal: whether you can feature it on your profile now (false if its rollo is private, or if its author, their rollo membership or their account does not let others; its author can unless the rollo is private; always false for the photos of a daily moment)",
    }),
    likeCount: z.number().int().optional().openapi({
      description: "Only after the reveal: how many people like it (one counter, also likes from profiles that feature it). Always 0 for videos",
    }),
    likedByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you like it" }),
    commentCount: z.number().int().optional().openapi({
      description: "Only after the reveal: how many comments you see on it (not the deleted ones, nor those of blocked users or ones you reported). Always 0 for videos",
    }),
    momentDay: z.string().nullable().optional().openapi({
      description: "Trip-local date (YYYY-MM-DD) when this photo is the answer to a daily moment; absent for ordinary photos",
    }),
    selfie: z
      .object({
        id: z.string().uuid(),
        width: nullableNumber,
        height: nullableNumber,
        thumbhash: z.string().nullable(),
        files: z.object({ thumb: z.string(), original: z.string() }).nullable().openapi({
          description: "Download paths; null before the reveal",
        }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Only on moment photos: the selfie taken with it (null if there is none yet). Selfies are never items of their own. width/height are null before the reveal",
      }),
  })
  .openapi("FeedItem");

export const FeedResponseSchema = z
  .object({
    revealed: z.boolean(),
    revealAt: z.number().int(),
    items: z.array(FeedItemSchema),
  })
  .openapi("Feed");

const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const MediaFileParams = z.object({
  tripId: pathParam("tripId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
