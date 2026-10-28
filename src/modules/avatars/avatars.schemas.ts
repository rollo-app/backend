import { z } from "@hono/zod-openapi";

export const AvatarParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
  file: z.string().openapi({ param: { name: "file", in: "path" }, example: "3f1c2a.jpg" }),
});
