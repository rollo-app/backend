import { z } from "@hono/zod-openapi";

export const ReportReasonSchema = z.enum(["offensive", "abuse", "other"]).openapi("ReportReason");

export const CreateReportSchema = z
  .object({
    reason: ReportReasonSchema,
    mediaId: z.string().trim().min(1).max(64).optional().openapi({ description: "Photo or video to report" }),
    userId: z.string().trim().min(1).max(64).optional().openapi({ description: "Person to report" }),
  })
  .refine((b) => (b.mediaId !== undefined) !== (b.userId !== undefined), "Mandá la foto o la persona, no las dos")
  .openapi("CreateReportRequest");
export type CreateReportInput = z.infer<typeof CreateReportSchema>;
