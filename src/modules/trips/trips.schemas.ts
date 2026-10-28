import { z } from "@hono/zod-openapi";
import { isValidTimeZone } from "../../lib/util";
import { epochMs, pathParam, PAST_TOLERANCE_MS } from "../../schemas";

export const CreateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ example: "Viaje al sur" }),
    timezone: z
      .string()
      .refine(isValidTimeZone, "Zona horaria inválida")
      .openapi({ example: "America/Argentina/Buenos_Aires", description: "IANA time zone of the destination" }),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end; must be after startsAt"),
    revealAt: epochMs("When the roll is revealed; must be >= endsAt"),
    dailyPhotoLimit: z.number().int().min(1).max(100).default(10),
    dailyVideoLimit: z.number().int().min(0).max(20).default(0).openapi({ description: "Legacy: rollos have no videos, omit it" }),
    featuringDisabled: z.boolean().default(false).openapi({ description: "Private rollo: nobody can feature its photos on a profile, not even their author" }),
    photoLimitMode: z.enum(["daily", "total"]).default("daily"),
    totalPhotoLimit: z.number().int().min(1).max(500).optional().openapi({
      description: "Photos per person in the whole rollo; required when photoLimitMode is total, ignored otherwise",
    }),
    momentMode: z.enum(["off", "photo", "photo_selfie"]).default("off").openapi({
      description: "Daily moment: off, a photo, or a photo plus a selfie. Cannot be changed after creating the rollo",
    }),
    momentWindowStart: z.number().int().min(0).max(1440).default(540).openapi({
      description: "Start of the daily moment window, in minutes from midnight in the rollo's time zone (default 540 = 9:00)",
    }),
    momentWindowEnd: z.number().int().min(0).max(1440).default(1380).openapi({
      description: "End of the daily moment window, in minutes from midnight; at least 30 after the start (default 1380 = 23:00)",
    }),
  })
  .refine((d) => d.momentWindowEnd - d.momentWindowStart >= 30, {
    message: "La franja del momento tiene que durar al menos 30 minutos",
    path: ["momentWindowEnd"],
  })
  .refine((d) => d.photoLimitMode !== "total" || d.totalPhotoLimit !== undefined, {
    message: "Elegí cuántas fotos por persona tiene el rollo",
    path: ["totalPhotoLimit"],
  })
  .refine((d) => d.startsAt >= Date.now() - PAST_TOLERANCE_MS, { message: "El inicio no puede ser en el pasado", path: ["startsAt"] })
  .refine((d) => d.endsAt > d.startsAt, { message: "El rollo tiene que terminar después de empezar", path: ["endsAt"] })
  .refine((d) => d.revealAt >= d.endsAt, { message: "El revelado no puede ser antes del fin", path: ["revealAt"] })
  .openapi("CreateTripRequest");

export const JoinTripSchema = z
  .object({
    code: z.string().trim().toUpperCase().length(6).openapi({ example: "HUB5FT" }),
  })
  .openapi("JoinTripRequest");

export const UpdateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    endsAt: z.number().int().positive().optional().openapi({ description: "Trip end; must be after startsAt and <= the resulting revealAt" }),
    revealAt: z.number().int().positive().optional().openapi({ description: "Must be >= the resulting endsAt" }),
    dailyPhotoLimit: z.number().int().min(1).max(100).optional(),
    dailyVideoLimit: z.number().int().min(0).max(20).optional(),
    featuringDisabled: z.boolean().optional().openapi({
      description: "Private rollo. Turning it on removes every photo of the rollo from every profile; turning it off restores nothing",
    }),
    totalPhotoLimit: z.number().int().min(1).max(500).optional().openapi({ description: "Only for rollos in total mode" }),
  })
  .openapi("UpdateTripRequest");

export const UpdateMyMembershipSchema = z
  .object({
    allowFeaturing: z.boolean().optional().openapi({
      description: "Others may feature your photos of this rollo. Turning it off removes them from other profiles; turning it on restores nothing",
    }),
    archived: z.boolean().optional().openapi({
      description: "Archive the rollo for you only (revealed rollos only, 409 otherwise); it stays in your list marked as archived",
    }),
  })
  .refine((b) => b.allowFeaturing !== undefined || b.archived !== undefined, "Mandá al menos un campo")
  .openapi("UpdateMyMembershipRequest");

export const MyMembershipSchema = z.object({ allowFeaturing: z.boolean(), archived: z.boolean() }).openapi("MyMembership");

export const AddMembersSchema = z
  .object({
    friendIds: z.array(z.string().min(1).max(64)).min(1).max(50).openapi({ description: "User ids of your friends (1 to 50)" }),
  })
  .openapi("AddMembersRequest");

export const AddMembersResponseSchema = z
  .object({
    results: z.array(
      z.object({
        userId: z.string(),
        status: z.enum(["added", "already_member", "unavailable"]).openapi({
          description:
            "added: now a member (also if they had left); already_member; unavailable: not your friend, removed by the admin (unless the caller is the admin), or unknown",
        }),
      }),
    ),
  })
  .openapi("AddMembersResponse");

export const TripMemberParams = z.object({ tripId: pathParam("tripId"), memberId: pathParam("memberId") });

export type CreateTripInput = z.infer<typeof CreateTripSchema>;
export type UpdateTripInput = z.infer<typeof UpdateTripSchema>;
