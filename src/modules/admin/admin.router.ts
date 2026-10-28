import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminAuth } from "../../lib/admin-auth";
import * as controller from "./admin.controller";

/**
 * Operator endpoints (curl with ADMIN_TOKEN, or a superadmin session for reads). A plain Hono app on purpose: it is not part of openapi.json.
 * Every failure to authenticate is a 404, so the routes look like they do not exist.
 */
const admin = new Hono<AppEnv>();

// Reads accept ADMIN_TOKEN or a superadmin session; destructive routes stay ADMIN_TOKEN-only.
admin.get("/me", adminAuth({ session: true }), controller.me);
admin.get("/reports", adminAuth({ session: true }), controller.listReports);
admin.get("/degraded-mode", adminAuth({ session: true }), controller.getDegradedMode);
admin.put("/degraded-mode", adminAuth({ session: true }), controller.setDegradedMode);
admin.get("/metrics", adminAuth({ session: true }), controller.getMetrics);
admin.get("/usage", adminAuth({ session: true }), controller.getUsage);
admin.get("/users", adminAuth({ session: true }), controller.listUsers);
admin.get("/users/:id", adminAuth({ session: true }), controller.getUser);
admin.delete("/media/:mediaId", adminAuth({ session: false }), controller.deleteMedia);
admin.delete("/users/:userId", adminAuth({ session: false }), controller.deleteUser);

export default admin;
