import { z } from "@hono/zod-openapi";

export const EventCodeParams = z.object({
  code: z.string().trim().toUpperCase().openapi({ param: { name: "code", in: "path" }, example: "HUB5FT" }),
});

export const EventPreviewSchema = z
  .object({
    name: z.string(),
    coverUrl: z.string().nullable().openapi({ description: "Path of the cover (prefix the API base URL), null if none" }),
    revealed: z.boolean(),
    memberCount: z.number().int().nullable().openapi({
      description:
        "People already in the event: active members (not left, not removed), organizers included — the accounts that will be able to download the photos after the reveal. null below 5, so a near-empty event does not show a tiny number to strangers",
    }),
    groups: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  })
  .openapi("EventPreview");
