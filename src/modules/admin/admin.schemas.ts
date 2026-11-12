import { z } from "zod";
import { PageQuerySchema } from "../../lib/paging";
import { UpdateProfileSchema, UserBadgeSchema } from "../../schemas";

export const DegradedModeBodySchema = z.object({ on: z.boolean() });

export const MetricsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  appRole: z.enum(["user", "superadmin"]),
  badge: z.enum(["founder", "first_edition"]).nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  tripCount: z.number(),
  mediaCount: z.number(),
});

export const TripStateSchema = z.enum(["upcoming", "open", "ended", "revealed"]);

export const AdminUserDetailSchema = AdminUserSchema.extend({
  bio: z.string().nullable(),
  unlimitedRollos: z.boolean(),
  trips: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(["admin", "member"]), state: TripStateSchema })),
});

/** Same rules as `PATCH /me` for name, username and bio (reused, not copied); anything else is rejected. */
export const AdminEditUserSchema = z
  .object({
    ...UpdateProfileSchema.pick({ name: true, username: true, bio: true }).shape,
    badge: UserBadgeSchema.optional(),
    unlimitedRollos: z.boolean().optional(),
  })
  .strict();
export type AdminEditUser = z.infer<typeof AdminEditUserSchema>;

export const MAX_TRIP_MEMBERS = 1000;

/** Only the cap is editable; the lower bound (the current active count) depends on the rollo, so the service checks it. */
export const AdminEditTripSchema = z.object({ maxMembers: z.number().int().min(1).max(MAX_TRIP_MEMBERS) }).strict();
export type AdminEditTrip = z.infer<typeof AdminEditTripSchema>;

/** Paging for the rollos list; `q` is 2 to 60 characters once trimmed (empty means no search). */
export const AdminTripsQuerySchema = PageQuerySchema.extend({
  q: z
    .string()
    .trim()
    .max(60)
    .refine((s) => s === "" || s.length >= 2)
    .optional(),
});
