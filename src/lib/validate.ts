import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";

/** zValidator que responde `{ error }` con el primer mensaje, en vez del detalle completo de zod. */
export const validate = <T extends ZodType>(target: "json" | "query", schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.join(".");
      const message = issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Datos inválidos";
      return c.json({ error: message }, 400);
    }
  });
