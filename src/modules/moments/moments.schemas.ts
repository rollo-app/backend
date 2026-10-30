import { z } from "@hono/zod-openapi";

export const MomentSchema = z
  .object({
    day: z.string().openapi({ description: "Local date of the trip (YYYY-MM-DD)", example: "2027-01-12" }),
    notifyAt: z.number().int().openapi({ description: "Epoch ms when the moment starts; the user has 15 minutes from then" }),
    mode: z
      .enum(["photo", "photo_selfie"])
      .optional()
      .openapi({ description: "How this moment is taken, fixed when it was drawn; later changes to the rollo do not affect it" }),
  })
  .openapi("Moment");

export const MyMomentsSchema = z.object({ moments: z.array(MomentSchema) }).openapi("MyMoments");

export const AllMyMomentsSchema = z
  .object({
    trips: z.array(
      z.object({
        tripId: z.string().uuid(),
        tripName: z.string(),
        momentMode: z.enum(["photo", "photo_selfie"]),
        moments: z.array(MomentSchema),
      }),
    ),
  })
  .openapi("AllMyMoments");
