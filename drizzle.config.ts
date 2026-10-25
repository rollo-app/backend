import { defineConfig } from "drizzle-kit";

// Only used by `npm run db:check-schema` (generates DDL from the schema into a git-ignored dir).
// Migrations are the hand-written SQL files in `migrations/`, applied with wrangler.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: process.env.DRIZZLE_OUT ?? "./.drizzle-check",
});
