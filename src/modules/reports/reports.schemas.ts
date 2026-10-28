import { z } from "@hono/zod-openapi";

export const ReportReasonSchema = z.enum(["offensive", "abuse", "other"]).openapi("ReportReason");

export const CreateReportSchema = z
  .object({
    reason: ReportReasonSchema,
    mediaId: z.string().trim().min(1).max(64).optional().openapi({ description: "Photo or video to report" }),
    userId: z.string().trim().min(1).max(64).optional().openapi({ description: "Person to report" }),
    commentId: z.string().trim().min(1).max(64).optional().openapi({ description: "Comment to report (on a photo of a rollo you are in)" }),
  })
  .refine((b) => [b.mediaId, b.userId, b.commentId].filter((v) => v !== undefined).length === 1, "Mandá solo la foto, la persona o el comentario")
  .openapi("CreateReportRequest");
export type CreateReportInput = z.infer<typeof CreateReportSchema>;
