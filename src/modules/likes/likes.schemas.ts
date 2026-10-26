import { z } from "@hono/zod-openapi";

export const DEFAULT_LIKES_PAGE = 60;
export const MAX_LIKES_PAGE = 100;

export const MyLikesQuery = z.object({
  cursor: z.string().optional().openapi({ param: { name: "cursor", in: "query" }, description: "`nextCursor` of the previous page" }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIKES_PAGE)
    .optional()
    .openapi({ param: { name: "limit", in: "query" }, description: `Page size (default ${DEFAULT_LIKES_PAGE})` }),
});

export const LikedPhotoSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("trip"), tripId: z.string().uuid() }),
    z.object({ kind: z.literal("featured"), userId: z.string().uuid().openapi({ description: "Owner of the profile where it is featured" }) }),
  ])
  .openapi("LikedPhotoSource", {
    description:
      "Where you can open the photo today. `trip`: you are an active member of its revealed rollo. `featured`: you see it on that profile " +
      "(the rollo is never revealed). If both work, it is `trip`.",
  });

export const LikedPhotoSchema = z
  .object({
    mediaId: z.string().uuid(),
    likedAt: z.number().int().openapi({ description: "When you liked it (epoch ms)" }),
    authorUserId: z.string().uuid(),
    author: z
      .object({ id: z.string().uuid(), name: z.string(), username: z.string().nullable(), avatarUrl: z.string().nullable() })
      .openapi({ description: "Who took it (for the badge on the thumbnail)" }),
    thumbPath: z.string().openapi({ example: "/trips/<tripId>/media/<mediaId>/thumb" }),
    thumbHash: z.string().nullable(),
    source: LikedPhotoSourceSchema,
  })
  .openapi("LikedPhoto");

export const MyLikesSchema = z
  .object({
    items: z.array(LikedPhotoSchema).openapi({ description: "Most recent like first" }),
    nextCursor: z.string().nullable().openapi({ description: "null on the last page" }),
    total: z.number().int().openapi({ description: "How many liked photos you can see today, across all pages" }),
  })
  .openapi("MyLikes");
