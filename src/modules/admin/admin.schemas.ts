import { z } from "zod";

export const DegradedModeBodySchema = z.object({ on: z.boolean() });
