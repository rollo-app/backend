import { swaggerUI } from "@hono/swagger-ui";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./lib/openapi";
import { globalRateLimit } from "./lib/rate-limit";
import { checkPushReceipts } from "./lib/push";
import { DEV_UPLOAD_PREFIX, devUploadsEnabled, verifyDevUpload } from "./lib/r2";
import { runTripNotices } from "./lib/trip-notices";
import admin from "./modules/admin/admin.router";
import auth from "./modules/auth/auth.router";
import blocks from "./routes/blocks";
import featured from "./routes/featured";
import friends, { friendLinks } from "./modules/friends/friends.router";
import likes from "./routes/likes";
import avatars from "./routes/avatars";
import me from "./routes/me";
import media from "./modules/media/media.router";
import { STATUS_BY_KIND, AppError } from "./shared/errors";
import { checkStorage } from "./lib/storage";
import { sweepOrphanAvatars } from "./lib/avatar-sweep";
import { purgeOldEmailCounters } from "./lib/email-caps";
import { sendModerationSummary } from "./lib/moderation-summary";
import { cleanupStalePending } from "./lib/pending-cleanup";
import reports from "./routes/reports";
import trips from "./modules/trips/trips.router";
import users from "./modules/users/users.router";
import usernames from "./routes/usernames";
import type { Env } from "./types";

const app = createApp();

app.use("*", globalRateLimit);

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
  const verified = await verifyDevUpload(c.env, key, c.req.query("exp"), c.req.query("sig"), c.req.query("size"));
  if (!verified) return c.json({ error: "Firma inválida o vencida" }, 403);
  const contentType = c.req.header("content-type");
  const bytes = await c.req.arrayBuffer();
  if (verified.size !== null && bytes.byteLength !== verified.size) {
    return c.json({ error: "El tamaño del archivo no coincide con el firmado" }, 403);
  }
  await c.env.MEDIA.put(key, bytes, contentType ? { httpMetadata: { contentType } } : undefined);
  return c.body(null, 200);
});

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.message }, STATUS_BY_KIND[err.kind]);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

/** Cron Trigger (every 5 min, `wrangler.jsonc`): "Arrancó" / "Se reveló" pushes, the Expo receipts check and the cleanup of stale pending uploads and the sweep of orphan avatar files. */
async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = controller.scheduledTime;
  ctx.waitUntil(
    Promise.allSettled([runTripNotices(env, now), checkPushReceipts(env, now), cleanupStalePending(env, now), sweepOrphanAvatars(env, now), checkStorage(env, now), sendModerationSummary(env, now), purgeOldEmailCounters(env, now)]).then((results) => {
      for (const r of results) if (r.status === "rejected") console.error("cron failed", r.reason);
    }),
  );
}

export default Object.assign(app, { scheduled });
