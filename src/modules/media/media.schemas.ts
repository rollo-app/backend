import { z } from "@hono/zod-openapi";
import { isBase64 } from "../../lib/util";
import { epochMs, MediaTypeSchema, nullableNumber } from "../../schemas";

export const MAX_VIDEO_SECONDS = 15.5; // 15 s + rounding margin
const MB = 1024 * 1024;
export const MAX_SIZE = { photo: 12 * MB, video: 30 * MB } as const;
export const MAX_THUMB_SIZE = 2 * MB;
/** 2048 px compressed JPEG, kept forever (a 2048 px JPEG at decent quality is well under this). */
export const MAX_DISPLAY_SIZE = 4 * MB;

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
    displaySizeBytes: z.number().int().positive().optional().openapi({
      description:
        "Photos only. Exact byte size of the display JPEG (2048 px, compressed, up to 4 MB); when present the response's `upload` also has a signed `display` URL for exactly this Content-Length. " +
        "Omit it (older builds) and the photo keeps its original forever.",
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
  .refine((d) => d.type === "photo" || d.displaySizeBytes == null, {
    message: "Solo las fotos tienen versión de visualización",
    path: ["displaySizeBytes"],
  })
  .refine((d) => d.displaySizeBytes == null || d.displaySizeBytes <= MAX_DISPLAY_SIZE, {
    message: "La versión de visualización es demasiado grande",
    path: ["displaySizeBytes"],
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
      display: z.string().url().optional().openapi({
        description: "Only when `displaySizeBytes` was sent: PUT of the display JPEG (2048px); send exactly `displaySizeBytes` bytes as Content-Length",
      }),
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
    width: nullableNumber.optional().openapi({ description: "Only after the reveal (and for the photos of a daily moment, right away)" }),
    height: nullableNumber.optional().openapi({ description: "Only after the reveal (and for the photos of a daily moment, right away)" }),
    files: z
      .object({
        thumb: z.string(),
        original: z.string().openapi({
          description: "Always present. Once the original was purged (30 days after the reveal) the same path serves the display file instead; see `originalAvailable`",
        }),
        display: z.string().optional().openapi({ description: "2048px version, kept forever; absent for uploads from builds that predate it (they keep their original)" }),
      })
      .optional()
      .openapi({ description: "Download paths; only after the reveal, except for the photos of a daily moment (main and linked image), which any active member gets as soon as they are uploaded" }),
    originalAvailable: z.boolean().optional().openapi({
      description: "Comes with `files`: false once the full-quality original was deleted (the `original` path then serves the display file). Always true for videos and for uploads without a display",
    }),
    featuredByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you featured it on your profile" }),
    featureBlocked: z.boolean().optional().openapi({
      description: "Only after the reveal: the author does not let others feature it (they still can)",
    }),
    canFeature: z.boolean().optional().openapi({
      description:
        "Only after the reveal: whether you can feature it on your profile now (false if its rollo is private, if its author is neither you nor one of your friends, or if its author, their rollo membership or their account does not let others; its author can unless the rollo is private; always false for the photos of a daily moment)",
    }),
    likeCount: z.number().int().optional().openapi({
      description: "Only after the reveal: how many people like it (one counter, also likes from profiles that feature it). Always 0 for videos",
    }),
    likedByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you like it" }),
    archived: z.boolean().optional().openapi({
      description:
        "Only after the reveal: its author archived it. Archived items only reach their author (everyone else never gets them), so it is only ever true in your own feed",
    }),
    commentCount: z.number().int().optional().openapi({
      description: "After the reveal, and before it on a daily moment's photo: how many comments you see on it (not the deleted ones, nor those of blocked users or ones you reported). Always 0 for videos",
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
        files: z.object({ thumb: z.string(), original: z.string(), display: z.string().optional() }).nullable().openapi({
          description: "Download paths (the linked image of a moment is visible to active members as soon as it is uploaded)",
        }),
        originalAvailable: z.boolean().optional().openapi({ description: "false once the linked image's original was deleted (the `original` path then serves the display file)" }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Only on moment photos: the selfie taken with it (null if there is none yet). Selfies are never items of their own. it comes with files and dimensions right away",
      }),
  })
  .openapi("FeedItem");

export const DEFAULT_FEED_PAGE = 30;
export const MAX_FEED_PAGE = 100;

export const FeedQuery = z.object({
  order: z
    .enum(["asc", "desc"])
    .optional()
    .openapi({
      param: { name: "order", in: "query" },
      description:
        "`asc` (default): oldest first. `desc`: newest first. A cursor is only valid with the order it was produced with: keep the same `order` on every page.",
    }),
  cursor: z.string().optional().openapi({ param: { name: "cursor", in: "query" }, description: "`nextCursor` of the previous page" }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_FEED_PAGE)
    .optional()
    .openapi({
      param: { name: "limit", in: "query" },
      description: `Page size (1-${MAX_FEED_PAGE}; default ${DEFAULT_FEED_PAGE} when only \`cursor\` is sent)`,
    }),
});

export const FeedResponseSchema = z
  .object({
    revealed: z.boolean(),
    revealAt: z.number().int(),
    items: z.array(FeedItemSchema),
    nextCursor: z.string().nullable().openapi({ description: "Pass it as `cursor` to get the next page; null when there are no more items (always null without cursor or limit)" }),
  })
  .openapi("Feed");

const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const MediaFileParams = z.object({
  tripId: pathParam("tripId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original", "display"]).openapi({ param: { name: "variant", in: "path" } }),
});
