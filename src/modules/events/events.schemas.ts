import { z } from "@hono/zod-openapi";

export const EventCodeParams = z.object({
  code: z.string().trim().toUpperCase().openapi({ param: { name: "code", in: "path" }, example: "HUB5FT" }),
});

export const EventPreviewQuery = z.object({
  any: z
    .enum(["1"])
    .optional()
    .openapi({
      param: { name: "any", in: "query" },
      description:
        "Send `1` to also preview a regular trip. Without it a regular trip answers 404 'Código inválido' like before, so installed builds that treat any 200 as an event keep working.",
    }),
});

export const EventPreviewSchema = z
  .object({
    type: z.enum(["trip", "event"]).openapi({ description: "Kind of rollo; a regular trip has no groups" }),
    name: z.string(),
    coverUrl: z.string().nullable().openapi({ description: "Path of the cover (prefix the API base URL), null if none" }),
    description: z.string().nullable().openapi({ description: "Cover text set by the organizers; null if none" }),
    startsAt: z.number().int().openapi({ description: "Start of the rollo, ms since epoch" }),
    endsAt: z.number().int().openapi({ description: "End of the rollo, ms since epoch" }),
    timezone: z.string().openapi({ description: "IANA timezone of the rollo" }),
    revealed: z.boolean(),
    memberCount: z.number().int().nullable().openapi({
      description:
        "People already in the rollo: active members (not left, not removed), organizers included — the accounts that will be able to download the photos after the reveal. null below 5, so a near-empty rollo does not show a tiny number to strangers",
    }),
    groups: z.array(z.object({ id: z.string().uuid(), name: z.string() })).openapi({ description: "Groups the guest picks from; empty for a regular trip" }),
  })
  .openapi("EventPreview");
