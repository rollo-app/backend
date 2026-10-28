import { z } from "zod";

export const DegradedModeBodySchema = z.object({ on: z.boolean() });

export const MetricsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
