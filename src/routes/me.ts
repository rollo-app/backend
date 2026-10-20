import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { isRevealed, publicUser } from "../lib/util";
import { MyTripsSchema, UpdateProfileSchema, UserSchema } from "../schemas";
import type { Role, TripRow } from "../types";

const me = createApp();
const tags = ["Profile"];

const getMeRoute = createRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Your profile",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(UserSchema, "Your profile"), ...errors(401) },
});

me.openapi(getMeRoute, async (c) => c.json(publicUser(c.get("user")), 200));

const updateMeRoute = createRoute({
  method: "patch",
  path: "/",
  tags,
  summary: "Edit your profile",
  description: "The name is shown in every rollo you are part of. It does not have to be unique.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: UpdateProfileSchema } }, required: true } },
  responses: { 200: json(UserSchema, "Profile updated"), ...errors(400, 401) },
});

me.openapi(updateMeRoute, async (c) => {
  const user = c.get("user");
  const { name } = c.req.valid("json");
  await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
  return c.json(publicUser({ ...user, name }), 200);
});

const myTripsRoute = createRoute({
  method: "get",
  path: "/trips",
  tags,
  summary: "Your rollos",
  description: "Rollos you are an active member of, most recent start first.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(MyTripsSchema, "Your rollos"), ...errors(401) },
});

me.openapi(myTripsRoute, async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, m.role AS my_role,
            (SELECT COUNT(*) FROM media WHERE trip_id = t.id AND status = 'uploaded' AND deleted_at IS NULL) AS total_uploaded
     FROM members m JOIN trips t ON t.id = m.trip_id
     WHERE m.user_id = ? AND m.removed_at IS NULL
     ORDER BY t.starts_at DESC`,
  )
    .bind(c.get("user").id)
    .all<TripRow & { my_role: Role; total_uploaded: number }>();

  return c.json(
    {
      trips: results.map((t) => ({
        id: t.id,
        name: t.name,
        joinCode: t.join_code,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        revealAt: t.reveal_at,
        revealed: isRevealed(t, now),
        role: t.my_role,
        totalUploaded: t.total_uploaded,
      })),
    },
    200,
  );
});

export default me;
