import { z } from "@hono/zod-openapi";
import { pathParam } from "../../schemas";

export const COMMENT_MAX_LENGTH = 500;

export const CommentParams = z.object({ commentId: pathParam("commentId") });

export const CreateCommentSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Escribí algo para comentar")
      .max(COMMENT_MAX_LENGTH, `El comentario puede tener hasta ${COMMENT_MAX_LENGTH} caracteres`)
      .openapi({ description: `Plain text, trimmed, 1 to ${COMMENT_MAX_LENGTH} characters` }),
  })
  .openapi("CreateCommentRequest");
export type CreateCommentInput = z.infer<typeof CreateCommentSchema>;

export const CommentSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string(),
    createdAt: z.number().int().openapi({ description: "Epoch milliseconds" }),
    author: z.object({
      userId: z.string().uuid(),
      name: z.string(),
      username: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
    canDelete: z.boolean().openapi({ description: "You wrote it, the photo is yours, or you are the rollo admin" }),
  })
  .openapi("Comment");

export const CommentListSchema = z.object({ comments: z.array(CommentSchema) }).openapi("CommentList");

export const DEFAULT_MY_COMMENTS_PAGE = 60;
export const MAX_MY_COMMENTS_PAGE = 100;

export const MyCommentsQuery = z.object({
  cursor: z.string().optional().openapi({ param: { name: "cursor", in: "query" }, description: "`nextCursor` of the previous page" }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MY_COMMENTS_PAGE)
    .optional()
    .openapi({ param: { name: "limit", in: "query" }, description: `Page size (default ${DEFAULT_MY_COMMENTS_PAGE})` }),
});

export const MyCommentSchema = z
  .object({
    commentId: z.string().uuid(),
    mediaId: z.string().uuid().openapi({ description: "The photo you commented on" }),
    tripId: z.string().uuid().openapi({ description: "Its rollo, to open it in the gallery" }),
    text: z.string(),
    createdAt: z.number().int().openapi({ description: "When you wrote it (epoch ms)" }),
    thumbPath: z.string().openapi({ example: "/trips/<tripId>/media/<mediaId>/thumb" }),
    thumbHash: z.string().nullable(),
  })
  .openapi("MyComment");

export const MyCommentsSchema = z
  .object({
    items: z.array(MyCommentSchema).openapi({ description: "Newest comment first" }),
    nextCursor: z.string().nullable().openapi({ description: "null on the last page" }),
    total: z.number().int().openapi({ description: "How many of your comments you can open today, across all pages" }),
  })
  .openapi("MyComments");
