import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Usa los mismos bindings que producción (D1 y R2), pero locales y aislados.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Tests share one IP key and sign up many users: the real limits would trip them. The limit tests use their own low-limit stand-ins.
        ratelimits: Object.fromEntries(
          [["RL_GLOBAL", "1001"], ["RL_IP", "1002"], ["RL_EXPENSIVE", "1003"], ["RL_FILES", "1004"]].map(([name, namespace_id]) => [
            name,
            { namespace_id, simple: { limit: 1_000_000, period: 60 as const } },
          ]),
        ),
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          R2_ACCOUNT_ID: "test-account",
          R2_ACCESS_KEY_ID: "test-access-key",
          R2_SECRET_ACCESS_KEY: "test-secret",
          // Apagado aunque esté en tu .dev.vars; los tests que lo necesitan lo prenden por request.
          DEV_LOCAL_UPLOADS: "",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
