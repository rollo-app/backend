import { z } from "@hono/zod-openapi";

export const CoverParams = z.object({
  tripId: z.string().openapi({ param: { name: "tripId", in: "path" } }),
  file: z.string().openapi({ param: { name: "file", in: "path" }, example: "3f1c2a.jpg" }),
});
