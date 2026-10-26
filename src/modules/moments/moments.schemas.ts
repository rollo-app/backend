import { z } from "@hono/zod-openapi";

export const MomentSchema = z
  .object({
    day: z.string().openapi({ description: "Local date of the trip (YYYY-MM-DD)", example: "2027-01-12" }),
    notifyAt: z.number().int().openapi({ description: "Epoch ms when the moment starts; the user has 15 minutes from then" }),
  })
  .openapi("Moment");

export const MyMomentsSchema = z.object({ moments: z.array(MomentSchema) }).openapi("MyMoments");
