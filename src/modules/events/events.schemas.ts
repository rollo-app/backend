import { z } from "@hono/zod-openapi";

export const EventCodeParams = z.object({
  code: z.string().trim().toUpperCase().openapi({ param: { name: "code", in: "path" }, example: "HUB5FT" }),
});

export const EventPreviewSchema = z
  .object({
    name: z.string(),
    coverUrl: z.string().nullable().openapi({ description: "Path of the cover (prefix the API base URL), null if none" }),
    revealed: z.boolean(),
    groups: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  })
  .openapi("EventPreview");
