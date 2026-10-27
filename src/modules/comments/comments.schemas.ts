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
