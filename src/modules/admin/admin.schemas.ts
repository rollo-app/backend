import { z } from "zod";

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
  trips: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(["admin", "member"]), state: TripStateSchema })),
});
