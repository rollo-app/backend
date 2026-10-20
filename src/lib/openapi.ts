import { OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../schemas";
import type { AppEnv } from "../types";

/** Hono app with contract-based validation. Validation errors respond `{ error }`. */
export function createApp() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue?.path.join(".");
        // Our own refines already carry a clear message: no field prefix.
        const message = issue?.code === "custom" ? issue.message : issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Datos inválidos";
        return c.json({ error: message }, 400);
      }
    },
  });
}

export const bearerAuth = [{ bearerAuth: [] }];

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid data",
  401: "Missing or invalid session token",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict with the current state",
  429: "Daily limit or rate limit reached",
  502: "Upstream service failed",
};

/** Documented error responses for an endpoint. */
export function errors(...codes: (keyof typeof ERROR_DESCRIPTIONS)[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { description: ERROR_DESCRIPTIONS[code]!, content: { "application/json": { schema: ErrorSchema } } },
    ]),
  );
}

export function json<T>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } };
}
