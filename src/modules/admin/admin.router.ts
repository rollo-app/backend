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
admin.get("/registrations", adminAuth({ session: true }), controller.getRegistrations);
// Closing or opening sign-ups is session only (a superadmin at the panel), unlike the degraded-mode switch.
admin.put("/registrations", adminAuth({ session: true, token: false }), controller.setRegistrations);
admin.get("/waitlist", adminAuth({ session: true }), controller.listWaitlist);
admin.get("/waitlist.csv", adminAuth({ session: true }), controller.waitlistCsv);
admin.get("/metrics", adminAuth({ session: true }), controller.getMetrics);
admin.get("/usage", adminAuth({ session: true }), controller.getUsage);
admin.get("/users", adminAuth({ session: true }), controller.listUsers);
admin.get("/users/:id", adminAuth({ session: true }), controller.getUser);
// Editing is session only: the token is for scripts that don't edit profiles.
admin.patch("/users/:id", adminAuth({ session: true, token: false }), controller.editUser);
// Raising a rollo's member cap (paid rollos) is session only, like editing users.
admin.patch("/trips/:tripId", adminAuth({ session: true, token: false }), controller.editTrip);
admin.delete("/media/:mediaId", adminAuth({ session: false }), controller.deleteMedia);
admin.delete("/users/:userId", adminAuth({ session: false }), controller.deleteUser);

export default admin;
