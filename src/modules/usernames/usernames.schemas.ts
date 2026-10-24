import { z } from "@hono/zod-openapi";

export const UsernameParams = z.object({
  username: z.string().openapi({ param: { name: "username", in: "path" }, example: "juanifraga" }),
});

export const UsernameAvailabilitySchema = z
  .object({
    available: z.boolean().openapi({ description: "true if nobody else has it (also true if it is yours)" }),
    username: z.string().openapi({ description: "The normalized username that was checked" }),
  })
  .openapi("UsernameAvailability");
