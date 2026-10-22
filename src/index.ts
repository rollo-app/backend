import { swaggerUI } from "@hono/swagger-ui";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./lib/openapi";
import { checkPushReceipts } from "./lib/push";
import { DEV_UPLOAD_PREFIX, devUploadsEnabled, verifyDevUpload } from "./lib/r2";
import { runTripNotices } from "./lib/trip-notices";
import admin from "./routes/admin";
import auth from "./routes/auth";
import blocks from "./routes/blocks";
import featured from "./routes/featured";
import friends, { friendLinks } from "./routes/friends";
import likes from "./routes/likes";
import avatars from "./routes/avatars";
import me from "./routes/me";
import media from "./routes/media";
import reports from "./routes/reports";
import trips from "./routes/trips";
import users from "./routes/users";
import usernames from "./routes/usernames";
import type { Env } from "./types";

const app = createApp();

app.get("/", (c) => c.json({ ok: true, service: "rollo-api" }));

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Session token returned by POST /auth/email/verify",
});

app.route("/admin", admin);
app.route("/auth", auth);
app.route("/me", me);
app.route("/avatars", avatars);
app.route("/usernames", usernames);
app.route("/users", users);
app.route("/friends", friends);
app.route("/blocks", blocks);
app.route("/reports", reports);
app.route("/friend-links", friendLinks);
app.route("/trips", trips);
app.route("/", media);
app.route("/", featured);
app.route("/", likes);

// Contract: the mobile app generates its typed client from here.
app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Rollo API",
    version: "0.2.0",
    description: "Rollo backend: accounts, trips, shared rolls and the reveal at the end.",
  },
  servers: [{ url: "https://rollo-api.juanifraga.com" }],
});

app.get("/docs", swaggerUI({ url: "/openapi.json", title: "Rollo API" }));

// Development only (DEV_LOCAL_UPLOADS=1): receives the PUTs that go straight to R2 in production.
// Not part of the contract; when disabled, the route does not exist.
app.put(`${DEV_UPLOAD_PREFIX}*`, async (c, next) => {
  if (!devUploadsEnabled(c.env)) return next();
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice(DEV_UPLOAD_PREFIX.length));
  if (!(await verifyDevUpload(c.env, key, c.req.query("exp"), c.req.query("sig")))) {
    return c.json({ error: "Firma inválida o vencida" }, 403);
  }
  const contentType = c.req.header("content-type");
  await c.env.MEDIA.put(key, await c.req.arrayBuffer(), contentType ? { httpMetadata: { contentType } } : undefined);
  return c.body(null, 200);
});

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

/** Cron Trigger (every 5 min, `wrangler.jsonc`): "Arrancó" / "Se reveló" pushes and the Expo receipts check. */
async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = controller.scheduledTime;
  ctx.waitUntil(
    Promise.allSettled([runTripNotices(env, now), checkPushReceipts(env, now)]).then((results) => {
      for (const r of results) if (r.status === "rejected") console.error("cron failed", r.reason);
    }),
  );
}

export default Object.assign(app, { scheduled });
