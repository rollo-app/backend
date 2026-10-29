# Backoffice backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the backend everything the `front-admin` panel needs: the `superadmin` role, session access to `/admin/*`, daily metrics, Cloudflare usage polling with 80% alerts, a manual degraded mode, a reusable paging helper and a paginated users list.

**Architecture:** Three small migrations (`users.app_role`, `metrics_daily`, `app_settings`), three pure libs in `src/lib/` (`paging`, `cf-usage`, `degraded`), two new cron tasks hooked into `scheduled` in `src/index.ts`, and five endpoints added to the existing plain-Hono `/admin` router (`src/modules/admin/`, 4-layer module). The degraded-mode checks live in the services that own each blocked action. Nothing in the public contract (`openapi.json`) changes.

**Tech Stack:** Cloudflare Workers, Hono, D1 (Drizzle via `orm()` in `src/shared/db.ts`), vitest inside workerd (`test/helpers.ts`), zod 4.

**Spec:** `docs/decisiones/0002-backoffice.md` (sections §1–§7, §9, §10 are this plan; §8 is the `front-admin` plan).

## Global Constraints

- Branch `feature/backoffice` from `develop`; PR back to `develop`. Commits in Spanish, code and test names in English, user-facing `{ error }` messages in Spanish (`CLAUDE.md`).
- TDD: write the failing test first. Run only the touched test files, always `--maxWorkers=2`: `npx vitest run test/<file>.test.ts --maxWorkers=2`.
- `/admin/*` stays a plain Hono router, outside `openapi.json`. Run `npx vitest run test/openapi.test.ts --maxWorkers=2` at the end to prove the contract did not change.
- `npm run db:check-schema` must pass after every migration (`src/db/schema.ts` mirrors `migrations/*.sql`).
- Migration numbers: `0029` is taken by `feature/rollos-archivar-y-admins`. Use `0030`, `0031`, `0032`; if `develop` already has those by PR time, renumber before merging.
- Every failure to authenticate on `/admin/*` is `404 { error: "No encontrado" }`.
- Degraded-mode message, verbatim: `Rollo está en mantenimiento, probá más tarde` (HTTP 503 via `unavailable`).
- Free-tier limits as constants: Workers requests 100_000/day; D1 rows read 5_000_000/day; D1 rows written 100_000/day; R2 class A 1_000_000/month; R2 class B 10_000_000/month. Alert at 80%.
- `paginate`: `page` ≥ 1 default 1; `pageSize` 1–100 default 25; `order` `asc|desc` default `desc`; `q` trimmed, max 100 chars; unknown `sort` → `badRequest`.

## Review Focus

1. A superadmin session on `DELETE /admin/users/:id` or `DELETE /admin/media/:id` must get 404 (only `ADMIN_TOKEN` may delete) — test in Task 3.
2. A valid session of a plain `user` (and an expired session of a superadmin) on any `/admin/*` route must get 404, never 401/403 — test in Task 3.
3. `GET /admin/users?q=` with `%` or `_` in `q` must not act as a wildcard — test in Task 6 (escape `LIKE` or use `instr`).
4. The degraded flag flipped in D1 directly must be seen by the worker within 60 s, and tests must be able to clear the cache — test in Task 8.
5. The metrics snapshot must be idempotent (two cron runs in the same day write once; a failed run is retried by the next run) — test in Task 7.

---

### Task 1: Migration `users.app_role` and `app_role` in the session user

**Files:**
- Create: `migrations/0030_app_role.sql`
- Modify: `src/db/schema.ts` (`users` table), `src/types.ts` (`UserRow`), `src/lib/auth.ts:33-35` (`requireUser` SELECT)
- Test: `test/app-role.test.ts`

**Interfaces:**
- Produces: `UserRow.app_role: "user" | "superadmin"`; `AppRole` type exported from `src/types.ts`; `c.get("user").app_role` available after `requireUser`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/app-role.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers";

describe("users.app_role", () => {
  it("defaults to 'user' and is never exposed by the public contract", async () => {
    const { token, userId } = await signUp();
    const row = await env.DB.prepare("SELECT app_role FROM users WHERE id = ?").bind(userId).first<{ app_role: string }>();
    expect(row!.app_role).toBe("user");
    expect((await api("GET", "/me", { token })).body.user).not.toHaveProperty("appRole");
    expect((await api("GET", `/users/${userId}`, { token })).body.user).not.toHaveProperty("appRole");
  });

  it("rejects values other than user/superadmin", async () => {
    const { userId } = await signUp();
    await expect(env.DB.prepare("UPDATE users SET app_role = 'admin' WHERE id = ?").bind(userId).run()).rejects.toThrow(/CHECK/);
  });

  it("PATCH /me ignores appRole", async () => {
    const { token, userId } = await signUp();
    await api("PATCH", "/me", { token, body: { appRole: "superadmin" } });
    const row = await env.DB.prepare("SELECT app_role FROM users WHERE id = ?").bind(userId).first<{ app_role: string }>();
    expect(row!.app_role).toBe("user");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/app-role.test.ts --maxWorkers=2`
Expected: FAIL (`no such column: app_role`).

- [ ] **Step 3: Write the migration**

`migrations/0030_app_role.sql`:
```sql
-- Global role for the backoffice panel. Not the per-rollo role (members.role).
ALTER TABLE users ADD COLUMN app_role TEXT NOT NULL DEFAULT 'user' CHECK (app_role IN ('user', 'superadmin'));
```

- [ ] **Step 4: Mirror it in Drizzle and types**

In `src/db/schema.ts` `users`: `appRole: text("app_role", { enum: ["user", "superadmin"] }).notNull().default("user")` plus `check("users_app_role_check", sql\`${t.appRole} IN ('user', 'superadmin')\`)`.
In `src/types.ts`: `export type AppRole = "user" | "superadmin";` and `app_role: AppRole` on `UserRow`.
In `src/lib/auth.ts` `requireUser`: add `u.app_role` to the SELECT.
Check: does `PATCH /me` use a strict zod schema? If it already strips unknown keys, nothing to do; otherwise ensure `appRole` is not in `UpdateMeSchema`.

- [ ] **Step 5: Run tests, schema check, typecheck**

Run: `npx vitest run test/app-role.test.ts test/me.test.ts --maxWorkers=2 && npm run db:check-schema && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0030_app_role.sql src/db/schema.ts src/types.ts src/lib/auth.ts test/app-role.test.ts
git commit -m "Rol global app_role (user | superadmin) en users"
```

---

### Task 2: Migrations `metrics_daily` and `app_settings`

**Files:**
- Create: `migrations/0031_metrics_daily.sql`, `migrations/0032_app_settings.sql`
- Modify: `src/db/schema.ts` (two tables + inferred types)

**Interfaces:**
- Produces: tables `metrics_daily(day TEXT, metric TEXT, value INTEGER, PK(day, metric))` and `app_settings(key TEXT PK, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by_user_id TEXT NULL)`; Drizzle exports `metricsDaily`, `appSettings`, `MetricDaily`, `AppSetting`.

- [ ] **Step 1: Write the migrations**

```sql
-- 0031_metrics_daily.sql
-- One row per metric per UTC day, written by the cron (`snapshotDailyMetrics`). The panel reads this, never COUNT(*) live.
CREATE TABLE metrics_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);
```
```sql
-- 0032_app_settings.sql
-- Operator switches changed by a person from the panel (e.g. degraded_mode); cron_state stays for cron bookkeeping.
CREATE TABLE app_settings (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by_user_id TEXT
);
```

- [ ] **Step 2: Mirror in `src/db/schema.ts`** (`metricsDaily` with `primaryKey({ columns: [t.day, t.metric] })`, `appSettings`), add `MetricDaily`/`AppSetting` inferred types next to `CronState`.

- [ ] **Step 3: Verify**

Run: `npm run db:check-schema && npm run typecheck`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add migrations/0031_metrics_daily.sql migrations/0032_app_settings.sql src/db/schema.ts
git commit -m "Tablas metrics_daily y app_settings para el backoffice"
```

---

### Task 3: `/admin/*` accepts a superadmin session; `GET /admin/me`

**Files:**
- Modify: `src/modules/admin/admin.router.ts`, `src/modules/admin/admin.controller.ts`, `src/modules/admin/admin.service.ts`, `src/modules/admin/admin.repository.ts`
- Create: `src/lib/admin-auth.ts`
- Test: `test/admin-session.test.ts`; add a helper to `test/helpers.ts`

**Interfaces:**
- Produces: `adminAuth(opts: { session: boolean }): MiddlewareHandler<AppEnv>` in `src/lib/admin-auth.ts`. With `session: true` it accepts `Bearer <ADMIN_TOKEN>` or a superadmin session and sets `c.set("adminUser", UserRow | null)` (null for the token); with `session: false` only the token. Every failure → `404 { error: "No encontrado" }`. `AppEnv.Variables.adminUser: UserRow | null` added in `src/types.ts`.
- Produces: `GET /admin/me` → `{ id, email, name, appRole }` (with `ADMIN_TOKEN`: `{ id: null, email: null, name: null, appRole: "token" }`).
- Produces test helper `makeSuperadmin(): Promise<{ token, userId, email }>` in `test/helpers.ts` (signUp + `UPDATE users SET app_role='superadmin'`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/admin-session.test.ts
import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

const ENV = { ADMIN_TOKEN: "secret" };

describe("/admin with a session", () => {
  it("GET /admin/me answers the superadmin and 404s everyone else", async () => {
    const su = await makeSuperadmin();
    const me = await api("GET", "/admin/me", { token: su.token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: su.userId, email: su.email, name: "Test", appRole: "superadmin" });

    const plain = await signUp();
    expect((await api("GET", "/admin/me", { token: plain.token })).status).toBe(404);
    expect((await api("GET", "/admin/me")).status).toBe(404);
    expect((await api("GET", "/admin/me", { token: "not-a-session" })).status).toBe(404);
  });

  it("GET /admin/me with ADMIN_TOKEN answers appRole 'token'", async () => {
    const r = await api("GET", "/admin/me", { env: ENV, headers: { authorization: "Bearer secret" } });
    expect(r.status).toBe(200);
    expect(r.body.appRole).toBe("token");
  });

  it("an expired superadmin session is a 404", async () => {
    const su = await makeSuperadmin();
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await api("GET", "/admin/me", { token: su.token })).status).toBe(404);
  });

  it("destructive routes still need ADMIN_TOKEN: a superadmin session gets 404", async () => {
    const su = await makeSuperadmin();
    const { tripId, adminToken } = await newTrip();
    const mediaId = await uploadMedia(tripId, adminToken);
    expect((await api("DELETE", `/admin/media/${mediaId}`, { token: su.token, env: ENV })).status).toBe(404);
    expect((await api("DELETE", `/admin/users/${su.userId}`, { token: su.token, env: ENV })).status).toBe(404);
    expect((await api("DELETE", `/admin/media/${mediaId}`, { env: ENV, headers: { authorization: "Bearer secret" } })).status).toBe(204);
  });

  it("GET /admin/reports accepts both credentials", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/reports", { token: su.token })).status).toBe(200);
    expect((await api("GET", "/admin/reports", { env: ENV, headers: { authorization: "Bearer secret" } })).status).toBe(200);
  });
});
```
(Import `env` from `cloudflare:workers` for the expiry test.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/admin-session.test.ts --maxWorkers=2`
Expected: FAIL (`makeSuperadmin` not exported; `/admin/me` 404 for the superadmin).

- [ ] **Step 3: Add `makeSuperadmin` to `test/helpers.ts`**

`export async function makeSuperadmin(email?: string)`: calls `signUp(email)` then `env.DB.prepare("UPDATE users SET app_role = 'superadmin' WHERE id = ?")`.

- [ ] **Step 4: Implement `src/lib/admin-auth.ts`**

Move `sha256`/`safeEqual` out of `admin.router.ts` into this file. `adminAuth({ session })`: read the bearer; always run the constant-time compare against `ADMIN_TOKEN` (as today); if it matches → `adminUser = null`, `next()`. Else if `session` is true: look the token up exactly as `requireUser` does (extract that SELECT into an exported `findSessionUser(db, token, now): Promise<(UserRow & { session_id; last_used_at }) | null>` in `src/lib/auth.ts` and reuse it from both places, keeping the once-a-day touch in `requireUser` only); if found and `app_role === "superadmin"` → `adminUser = user`, `next()`. Anything else → `c.json({ error: "No encontrado" }, 404)`.

- [ ] **Step 5: Wire the router**

In `admin.router.ts`: remove the `admin.use("*")` middleware; apply per route:
```ts
admin.get("/me", adminAuth({ session: true }), controller.me);
admin.get("/reports", adminAuth({ session: true }), controller.listReports);
admin.delete("/media/:mediaId", adminAuth({ session: false }), controller.deleteMedia);
admin.delete("/users/:userId", adminAuth({ session: false }), controller.deleteUser);
```
Controller `me`: reads `c.get("adminUser")`, returns `{ id, email, name, appRole: user.app_role }` or the token shape.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/admin-session.test.ts test/admin.test.ts test/auth.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS (the old `admin.test.ts` must still pass unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-auth.ts src/lib/auth.ts src/types.ts src/modules/admin test/helpers.ts test/admin-session.test.ts
git commit -m "/admin acepta la sesión de un superadmin; GET /admin/me"
```

---

### Task 4: Paging helper `src/lib/paging.ts`

**Files:**
- Create: `src/lib/paging.ts`
- Test: `test/paging.test.ts`

**Interfaces:**
- Produces:
```ts
export const PageQuerySchema: z.ZodObject<{ page, pageSize, sort?, order, q? }>; // z.coerce for page/pageSize
export type PageQuery = z.infer<typeof PageQuerySchema>;
export const PageSchema = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), page: z.number(), pageSize: z.number(), total: z.number() });
export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };
export type PageSpec<TRow> = {
  rows: (opts: { orderBy: SQL; limit: number; offset: number }) => Promise<TRow[]>; // repository runs the list query
  count: () => Promise<number>;                                                    // repository runs the count query
  sortable: Record<string, SQL | AnyColumn>;
  defaultSort: string;
};
export async function paginate<TRow>(spec: PageSpec<TRow>, query: PageQuery): Promise<Page<TRow>>;
```
`paginate` resolves `sort` (unknown → `badRequest("Orden inválido")`), builds `orderBy` as `asc(col)`/`desc(col)` with the row id as tiebreak left to the repository, computes `offset = (page-1)*pageSize`, runs `rows` and `count` with `Promise.all`.

- [ ] **Step 1: Write the failing tests** (pure, no DB: fake `rows`/`count` that record their args)

```ts
// test/paging.test.ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PageQuerySchema, paginate } from "../src/lib/paging";

const spec = (rows: unknown[] = [], total = 0) => {
  const calls: any[] = [];
  return {
    calls,
    spec: {
      rows: async (o: any) => (calls.push(o), rows),
      count: async () => total,
      sortable: { createdAt: sql`created_at`, name: sql`name` },
      defaultSort: "createdAt",
    },
  };
};

describe("PageQuerySchema", () => {
  it("applies defaults and coerces numbers", () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25, order: "desc" });
    expect(PageQuerySchema.parse({ page: "3", pageSize: "50", q: "  ana " })).toMatchObject({ page: 3, pageSize: 50, q: "ana" });
  });
  it("rejects page 0, pageSize 101 and a 101-char q", () => {
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });
});

describe("paginate", () => {
  it("computes offset/limit and returns the page shape", async () => {
    const { spec: s, calls } = spec([{ id: 1 }], 57);
    const page = await paginate(s, PageQuerySchema.parse({ page: 3, pageSize: 20 }));
    expect(page).toEqual({ items: [{ id: 1 }], page: 3, pageSize: 20, total: 57 });
    expect(calls[0]).toMatchObject({ limit: 20, offset: 40 });
  });
  it("uses defaultSort desc, honors sort+order, rejects unknown sort", async () => {
    const { spec: s, calls } = spec();
    await paginate(s, PageQuerySchema.parse({}));
    expect(calls[0].orderBy.queryChunks.join("")).toMatch(/created_at.*desc/i);
    await paginate(s, PageQuerySchema.parse({ sort: "name", order: "asc" }));
    expect(calls[1].orderBy.queryChunks.join("")).toMatch(/name.*asc/i);
    await expect(paginate(s, PageQuerySchema.parse({ sort: "email" }))).rejects.toMatchObject({ kind: "bad_request" });
  });
});
```
(If inspecting `queryChunks` is awkward, assert via `orderBy.toSQL?.()` or expose a `resolveSort(spec, query): { column, order }` helper and test that instead; pick one and keep it.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/paging.test.ts --maxWorkers=2`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/paging.ts`** per the Interfaces block. Use `z.coerce.number().int()` for `page`/`pageSize`, `z.string().trim().max(100)` for `q`, `asc`/`desc` from `drizzle-orm`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/paging.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paging.ts test/paging.test.ts
git commit -m "Helper de paginado por páginas para las listas del panel"
```

---

### Task 5: Degraded mode: lib + `GET/PUT /admin/degraded-mode`

**Files:**
- Create: `src/lib/degraded.ts`
- Modify: `src/modules/admin/admin.router.ts`, `admin.controller.ts`, `admin.service.ts`, `admin.repository.ts`, `src/modules/admin/admin.schemas.ts` (create)
- Test: `test/degraded-mode.test.ts`

**Interfaces:**
- Produces in `src/lib/degraded.ts`:
```ts
export const DEGRADED_MESSAGE = "Rollo está en mantenimiento, probá más tarde";
export const DEGRADED_CACHE_MS = 60_000;
export async function isDegraded(env: Pick<Env, "DB">, now = Date.now()): Promise<boolean>; // cached per isolate for 60 s
export async function assertNotDegraded(env: Pick<Env, "DB">): Promise<void>;              // throws unavailable(DEGRADED_MESSAGE)
export function resetDegradedCache(): void;                                                 // tests
```
- Produces endpoints: `GET /admin/degraded-mode` → `{ on: boolean, updatedAt: number | null, updatedBy: { id, email } | null }`; `PUT /admin/degraded-mode { on: boolean }` → same body, 200. Both `adminAuth({ session: true })`. The PUT also calls `resetDegradedCache()` so the writing isolate sees it at once.
- Repository: `getSetting(db, key): Promise<AppSetting | null>`, `setSetting(db, { key, value, updatedAt, updatedByUserId }): D1PreparedStatement` (upsert).

- [ ] **Step 1: Write the failing tests**

```ts
// test/degraded-mode.test.ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isDegraded, resetDegradedCache } from "../src/lib/degraded";
import { api, makeSuperadmin, signUp } from "./helpers";

beforeEach(() => resetDegradedCache());

describe("degraded mode switch", () => {
  it("is off by default and the superadmin can turn it on and off", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/degraded-mode", { token: su.token })).body).toEqual({ on: false, updatedAt: null, updatedBy: null });
    const on = await api("PUT", "/admin/degraded-mode", { token: su.token, body: { on: true } });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ on: true, updatedBy: { id: su.userId, email: su.email } });
    expect(typeof on.body.updatedAt).toBe("number");
    expect(await isDegraded(env)).toBe(true);
    expect((await api("PUT", "/admin/degraded-mode", { token: su.token, body: { on: false } })).body.on).toBe(false);
    expect(await isDegraded(env)).toBe(false);
  });

  it("a plain user cannot read or change it", async () => {
    const { token } = await signUp();
    expect((await api("GET", "/admin/degraded-mode", { token })).status).toBe(404);
    expect((await api("PUT", "/admin/degraded-mode", { token, body: { on: true } })).status).toBe(404);
  });

  it("caches the flag for 60 s and refreshes after", async () => {
    expect(await isDegraded(env, 1_000_000)).toBe(false);
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
    expect(await isDegraded(env, 1_000_000 + 59_000)).toBe(false);
    expect(await isDegraded(env, 1_000_000 + 60_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/degraded-mode.test.ts --maxWorkers=2`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/degraded.ts`**

Module-level `let cache: { value: boolean; at: number } | null`. `isDegraded` returns the cached value when `now - cache.at < DEGRADED_CACHE_MS`; otherwise reads `app_settings` key `degraded_mode` (value `'1'` → true) and stores it. `assertNotDegraded` throws `unavailable(DEGRADED_MESSAGE)`.

- [ ] **Step 4: Implement the endpoints** in the admin module (`admin.schemas.ts`: `DegradedModeBodySchema = z.object({ on: z.boolean() })`; service `getDegradedMode(db)` / `setDegradedMode(db, on, actor: UserRow | null)` joining `users` for `updatedBy`; controller validates the body with the schema and maps zod errors to 400 `{ error: "Cuerpo inválido" }`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/degraded-mode.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/degraded.ts src/modules/admin test/degraded-mode.test.ts
git commit -m "Modo degradado: flag en app_settings con caché y endpoints de admin"
```

---

### Task 6: Degraded mode blocks uploads, new rollos, avatars and sign-ups

**Files:**
- Modify: `src/modules/media/media.service.ts:42-80` (`registerMedia`), `src/modules/me/me.service.ts:~56` (avatar request), `src/modules/trips/trips.service.ts:44` (`createTrip`), `src/modules/auth/auth.service.ts:35` (`startLogin`)
- Test: `test/degraded-blocks.test.ts`

**Interfaces:**
- Consumes: `assertNotDegraded(env)`, `isDegraded(env)`, `DEGRADED_MESSAGE`, `resetDegradedCache()` from Task 5.

- [ ] **Step 1: Write the failing tests**

```ts
// test/degraded-blocks.test.ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_MESSAGE, resetDegradedCache } from "../src/lib/degraded";
import { api, newTrip, photoBody, signUp, TZ, uploadMedia } from "./helpers";

const turnOn = () => env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
beforeEach(() => resetDegradedCache());

describe("degraded mode blocks", () => {
  it("registering a photo and requesting an avatar answer 503", async () => {
    const { tripId, adminToken } = await newTrip();
    await turnOn();
    const reg = await api("POST", `/trips/${tripId}/media`, { token: adminToken, body: photoBody() });
    expect(reg.status).toBe(503);
    expect(reg.body.error).toBe(DEGRADED_MESSAGE);
    const avatar = await api("POST", "/me/avatar", { token: adminToken, body: { sizeBytes: 1000 } });
    expect(avatar.status).toBe(503);
  });

  it("creating a rollo answers 503; viewing a feed still works", async () => {
    const { tripId, adminToken } = await newTrip();
    await uploadMedia(tripId, adminToken);
    await turnOn();
    const create = await api("POST", "/trips", { token: adminToken, body: { name: "Otro", timezone: TZ, startsAt: Date.now(), endsAt: Date.now() + 86_400_000 } });
    expect(create.status).toBe(503);
    expect((await api("GET", `/trips/${tripId}/feed`, { token: adminToken })).status).toBe(200);
  });

  it("login start: existing accounts get their code, new emails get 503", async () => {
    const existing = await signUp("ana@rollo.test");
    await turnOn();
    expect((await api("POST", "/auth/email/start", { body: { email: existing.email } })).status).toBe(204);
    const fresh = await api("POST", "/auth/email/start", { body: { email: "nueva@rollo.test" } });
    expect(fresh.status).toBe(503);
    expect(fresh.body.error).toBe(DEGRADED_MESSAGE);
  });
});
```
(Match `POST /trips` body fields to what `test/helpers.ts` `createTrip` sends; copy from there.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/degraded-blocks.test.ts --maxWorkers=2`
Expected: FAIL (statuses are 200/201/204).

- [ ] **Step 3: Add the checks in the services**

- `registerMedia`: `await assertNotDegraded(env)` as the first line (before the existing-id branch: retries are blocked too, per spec §5).
- `me.service.ts` avatar request: `await assertNotDegraded(env)` right before `assertStorageAvailable`.
- `createTrip`: it receives `db`, not `env`; add `await assertNotDegraded({ DB: db })` after `requireName(user)`.
- `startLogin`: after `isNewUser` is computed and before any email slot is reserved: `if (isNewUser && !isReview && (await isDegraded(env))) throw unavailable(DEGRADED_MESSAGE);`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/degraded-blocks.test.ts test/media.test.ts test/trips.test.ts test/auth.test.ts test/me.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/media/media.service.ts src/modules/me/me.service.ts src/modules/trips/trips.service.ts src/modules/auth/auth.service.ts test/degraded-blocks.test.ts
git commit -m "Modo degradado: frena subidas, avatares, rollos nuevos y altas"
```

---

### Task 7: Daily metrics snapshot (cron) and `GET /admin/metrics`

**Files:**
- Create: `src/modules/metrics/metrics.service.ts`, `src/modules/metrics/metrics.repository.ts`
- Modify: `src/index.ts:103-110` (`scheduled`), `src/modules/admin/admin.router.ts` + controller
- Test: `test/metrics.test.ts`

**Interfaces:**
- Produces:
```ts
// metrics.service.ts
export const METRICS = ["users_total","users_new","trips_total","trips_new","trips_open","trips_revealed_total","media_total","media_new","storage_bytes","active_users"] as const;
export type Metric = typeof METRICS[number];
export function utcDay(ms: number): string;                       // "YYYY-MM-DD"
export async function computeDailyMetrics(env: Env, day: string): Promise<Record<Metric, number>>; // for the UTC day [day 00:00, day+1 00:00)
export async function snapshotDailyMetrics(env: Env, now: number): Promise<boolean>; // true when it wrote; cron_state key "metrics_last_day"
export async function getMetrics(db: D1Database, days: number): Promise<{ latestDay: string | null; series: { day: string; values: Partial<Record<Metric, number>> }[] }>;
```
- Produces endpoint `GET /admin/metrics?days=30` (1–90, default 30) → `getMetrics` result, `adminAuth({ session: true })`.
- Repository: `upsertMetrics(db, day, values): D1PreparedStatement[]`, `listMetrics(db, fromDay): Promise<MetricDaily[]>`, plus one query per metric (`countUsers(db, before)`, `countUsersCreatedBetween(db, from, to)`, `countTrips…`, `countOpenTrips(db, at)`, `countRevealedTrips(db, before)`, `countUploadedMedia(db, before)`, `countMediaUploadedBetween(db, from, to)`, `countActiveSessions(db, from, to)`).

Definitions (spec §3): totals are "as of end of `day`" (`created_at < dayEnd`, `uploaded_at < dayEnd` for media with `status='uploaded' AND deleted_at IS NULL`); `_new` are `[dayStart, dayEnd)`; `trips_open` = `starts_at <= dayEnd AND revealed_at IS NULL AND reveal_at > dayEnd`; `trips_revealed_total` = `revealed_at IS NOT NULL AND revealed_at < dayEnd` OR `reveal_at < dayEnd`; `active_users` = `COUNT(DISTINCT user_id) FROM sessions WHERE last_used_at >= dayStart AND < dayEnd`; `storage_bytes` = `storageUsage(env)`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/metrics.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeDailyMetrics, snapshotDailyMetrics, utcDay } from "../src/modules/metrics/metrics.service";
import { DAY, api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

const rows = () => env.DB.prepare("SELECT day, metric, value FROM metrics_daily ORDER BY day, metric").all().then((r) => r.results);

describe("daily metrics", () => {
  it("computes the counts for a UTC day", async () => {
    const { tripId, adminToken } = await newTrip();
    await signUp();
    await uploadMedia(tripId, adminToken);
    const today = utcDay(Date.now());
    const m = await computeDailyMetrics(env, today);
    expect(m).toMatchObject({ users_total: 2, users_new: 2, trips_total: 1, trips_new: 1, trips_open: 1, media_total: 1, media_new: 1, active_users: 2 });
    expect(m.storage_bytes).toBeGreaterThan(0);
  });

  it("snapshot writes yesterday once, and again only on a new day", async () => {
    const now = Date.UTC(2026, 9, 28, 0, 10);
    expect(await snapshotDailyMetrics(env, now)).toBe(true);
    expect((await rows()).every((r: any) => r.day === "2026-10-27")).toBe(true);
    expect(await snapshotDailyMetrics(env, now + 60_000)).toBe(false);
    expect(await snapshotDailyMetrics(env, now + DAY)).toBe(true);
    expect(new Set((await rows()).map((r: any) => r.day))).toEqual(new Set(["2026-10-27", "2026-10-28"]));
  });

  it("GET /admin/metrics returns the series newest-last with the latest day", async () => {
    const su = await makeSuperadmin();
    await snapshotDailyMetrics(env, Date.UTC(2026, 9, 28, 0, 10));
    const r = await api("GET", "/admin/metrics?days=7", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body.latestDay).toBe("2026-10-27");
    expect(r.body.series.at(-1)).toMatchObject({ day: "2026-10-27", values: { users_total: 1 } });
    expect((await api("GET", "/admin/metrics?days=0", { token: su.token })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/metrics.test.ts --maxWorkers=2`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the module** per Interfaces. `snapshotDailyMetrics`: `const day = utcDay(now - DAY)`; read `cron_state.metrics_last_day`; if equal → return false; compute, `db.batch([...upsertMetrics, setCronState])`, return true. `getMetrics(db, days)`: `fromDay = utcDay(now - days*DAY)`, group rows by day ascending.

- [ ] **Step 4: Hook the cron and the route**

`src/index.ts` `scheduled`: add `snapshotDailyMetrics(env, now)` to the `Promise.allSettled([...])` list. `admin.router.ts`: `admin.get("/metrics", adminAuth({ session: true }), controller.getMetrics)` (controller parses `days` with `z.coerce.number().int().min(1).max(90).default(30)`, 400 `{ error: "Parámetros inválidos" }` on failure).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/metrics.test.ts test/storage.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/metrics src/index.ts src/modules/admin test/metrics.test.ts
git commit -m "Métricas diarias: snapshot por cron y GET /admin/metrics"
```

---

### Task 8: Cloudflare usage poll (cron), 80% alerts and `GET /admin/usage`

**Files:**
- Create: `src/lib/cf-usage.ts`
- Modify: `src/types.ts` (`Env.CF_ANALYTICS_TOKEN?: string`), `src/lib/email.ts` (`sendUsageAlert`, `devSentUsageAlerts`), `src/index.ts` (`scheduled`), `wrangler.jsonc` (comment listing the secret), admin router/controller
- Test: `test/cf-usage.test.ts`

**Interfaces:**
- Produces in `src/lib/cf-usage.ts`:
```ts
export const USAGE_LIMITS = { workers_requests: 100_000, d1_rows_read: 5_000_000, d1_rows_written: 100_000, r2_class_a: 1_000_000, r2_class_b: 10_000_000 } as const;
export type UsageMetric = keyof typeof USAGE_LIMITS;
export const ALERT_RATIO = 0.8;
export type Usage = { fetchedAt: number; values: Record<UsageMetric, number> };
export async function fetchUsage(env: Pick<Env, "CF_ANALYTICS_TOKEN" | "R2_ACCOUNT_ID" | "R2_BUCKET_NAME">, now: number, fetchImpl?: typeof fetch): Promise<Usage["values"]>; // GraphQL; throws on HTTP/GraphQL error
export async function pollUsage(env: Env, now: number, fetchImpl?: typeof fetch): Promise<void>; // cron task: no token → return; store JSON in cron_state "cf_usage"; alert once per metric per UTC day (cron_state "cf_usage_alerted:<metric>:<day>")
export async function getUsage(db: D1Database): Promise<(Usage & { limits: typeof USAGE_LIMITS }) | null>;
```
- Produces `GET /admin/usage` → `{ usage: null | { fetchedAt, values, limits }, storage: { usedBytes, limitBytes } }` (`storage` from `storageUsage`/`storageLimitBytes`), `adminAuth({ session: true })`.
- Produces in `src/lib/email.ts`: `sendUsageAlert(env, { metric, value, limit })` with subject `Rollo: ${metric} al ${pct}% del límite gratis de Cloudflare` and a body that says the degraded mode is switched on from the panel; without `RESEND_API_KEY` pushes to `devSentUsageAlerts`.

GraphQL (builder's call on exact dataset fields; spec leaves it open): `workersInvocationsAdaptive` filtered by `scriptName: "rollo-api"` and the UTC day; `d1AnalyticsAdaptiveGroups` (`readQueries`/`rowsRead`, `rowsWritten`) filtered by `databaseId`; `r2OperationsAdaptiveGroups` by `bucketName` and `actionType` class A/B for the month. Add `D1_DATABASE_ID` as a var in `wrangler.jsonc` `vars` if needed (`13f35fe4-...`).

- [ ] **Step 1: Write the failing tests** (mock `fetch` with a `fetchImpl` argument; never call Cloudflare)

```ts
// test/cf-usage.test.ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getUsage, pollUsage } from "../src/lib/cf-usage";
import { devSentUsageAlerts } from "../src/lib/email";
import { api, makeSuperadmin } from "./helpers";

const withToken = { ...env, CF_ANALYTICS_TOKEN: "t" } as typeof env;
const fakeFetch = (values: Record<string, number>) => {
  const calls: Request[] = [];
  const f = (async (input: any, init: any) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(graphqlPayload(values)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
};
// graphqlPayload: build the GraphQL response shape fetchUsage expects (define it in the test next to the queries).

beforeEach(() => { devSentUsageAlerts.length = 0; });

describe("cf usage", () => {
  it("does nothing without CF_ANALYTICS_TOKEN", async () => {
    await pollUsage(env, Date.now());
    expect(await getUsage(env.DB)).toBeNull();
  });

  it("stores the fetched values with fetchedAt", async () => {
    const { f, calls } = fakeFetch({ workers_requests: 41_200, d1_rows_read: 3_900_000, d1_rows_written: 12_000, r2_class_a: 10, r2_class_b: 20 });
    await pollUsage(withToken, 1_700_000_000_000, f);
    expect(calls[0].headers.get("authorization")).toBe("Bearer t");
    expect(await getUsage(env.DB)).toMatchObject({ fetchedAt: 1_700_000_000_000, values: { d1_rows_read: 3_900_000 } });
  });

  it("alerts once per metric per UTC day when over 80%", async () => {
    const { f } = fakeFetch({ workers_requests: 81_000, d1_rows_read: 100, d1_rows_written: 0, r2_class_a: 0, r2_class_b: 0 });
    const now = Date.UTC(2026, 9, 28, 12);
    await pollUsage(withToken, now, f);
    await pollUsage(withToken, now + 300_000, f);
    expect(devSentUsageAlerts).toHaveLength(1);
    expect(devSentUsageAlerts[0]).toMatchObject({ metric: "workers_requests", value: 81_000, limit: 100_000 });
    await pollUsage(withToken, now + 86_400_000, f);
    expect(devSentUsageAlerts).toHaveLength(2);
  });

  it("keeps the last value when the API fails", async () => {
    const { f } = fakeFetch({ workers_requests: 1, d1_rows_read: 1, d1_rows_written: 1, r2_class_a: 1, r2_class_b: 1 });
    await pollUsage(withToken, 1000, f);
    const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await pollUsage(withToken, 2000, failing);
    expect((await getUsage(env.DB))!.fetchedAt).toBe(1000);
  });

  it("GET /admin/usage returns usage and storage", async () => {
    const su = await makeSuperadmin();
    const r = await api("GET", "/admin/usage", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usage: null, storage: { usedBytes: 0, limitBytes: 10_000_000_000 } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cf-usage.test.ts --maxWorkers=2`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/cf-usage.ts`**, `sendUsageAlert` in `email.ts`, `CF_ANALYTICS_TOKEN` in `Env`, the secret comment in `wrangler.jsonc`. `pollUsage` catches `fetchUsage` errors, `console.error`s and returns (so the cron's `allSettled` stays quiet). Alerts: for each metric with `value >= limit * ALERT_RATIO` and no `cron_state` key for `(metric, utcDay(now))`, send and set the key. Purge alert keys older than 2 days in the same run (like `purgeOldEmailCounters`).

- [ ] **Step 4: Hook the cron and the route**

`scheduled`: add `pollUsage(env, now)`. `admin.router.ts`: `admin.get("/usage", adminAuth({ session: true }), controller.getUsage)`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/cf-usage.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cf-usage.ts src/lib/email.ts src/types.ts src/index.ts wrangler.jsonc src/modules/admin test/cf-usage.test.ts
git commit -m "Uso de Cloudflare por cron con alerta al 80% y GET /admin/usage"
```

---

### Task 9: Users list and detail (`GET /admin/users`, `GET /admin/users/:id`)

**Files:**
- Modify: `src/modules/admin/admin.router.ts`, `admin.controller.ts`, `admin.service.ts`, `admin.repository.ts`, `admin.schemas.ts`
- Test: `test/admin-users.test.ts`

**Interfaces:**
- Consumes: `paginate`, `PageQuerySchema`, `PageSchema` (Task 4); `adminAuth` (Task 3).
- Produces: `AdminUserSchema` (zod) `{ id, email, name, username, appRole, badge, createdAt, lastSeenAt: number | null, tripCount, mediaCount }`; `GET /admin/users?page&pageSize&sort&order&q` → `PageSchema(AdminUserSchema)`; sortable `createdAt` (default), `lastSeenAt`, `name`, `email`; `q` matches `email`, `name`, `username` case-insensitively with `%`/`_` escaped (`LIKE ... ESCAPE '\'`). `GET /admin/users/:id` → `AdminUser & { trips: { id, name, role: "admin" | "member", state: "upcoming" | "open" | "ended" | "revealed" }[] }`, 404 if missing. Repository: `listUsers(db, { q, orderBy, limit, offset }): Promise<AdminUserRow[]>`, `countUsers(db, { q })`, `findAdminUser(db, id)`, `listUserTrips(db, userId)` (active memberships, `removed_at IS NULL AND left_at IS NULL`). Aggregates `lastSeenAt`, `tripCount`, `mediaCount` via correlated subqueries in the same statement (no N+1); `mediaCount` = `status='uploaded' AND deleted_at IS NULL` through `members`.
- `state`: `revealed` if `revealed_at IS NOT NULL OR reveal_at <= now`; else `upcoming` if `starts_at > now`; else `ended` if `ends_at < now`; else `open`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/admin-users.test.ts
import { describe, expect, it } from "vitest";
import { api, makeSuperadmin, newTrip, signUp, uploadMedia } from "./helpers";

describe("GET /admin/users", () => {
  it("pages, sorts by createdAt desc by default and aggregates counts", async () => {
    const su = await makeSuperadmin("su@rollo.test");
    const { tripId, adminToken } = await newTrip(); // creates a user with a trip
    await uploadMedia(tripId, adminToken);
    const r = await api("GET", "/admin/users?pageSize=1", { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(r.body.items).toHaveLength(1);
    const creator = (await api("GET", "/admin/users?pageSize=10&sort=createdAt&order=asc", { token: su.token })).body.items.at(-1);
    expect(creator).toMatchObject({ tripCount: 1, mediaCount: 1, appRole: "user" });
    expect(typeof creator.lastSeenAt).toBe("number");
  });

  it("q searches email, name and username without wildcards", async () => {
    const su = await makeSuperadmin();
    await signUp("ana_perez@rollo.test", "Ana", "anita");
    await signUp("beto@rollo.test", "Beto", "beto");
    const by = async (q: string) => (await api("GET", `/admin/users?q=${encodeURIComponent(q)}`, { token: su.token })).body.items.map((u: any) => u.email);
    expect(await by("ANA")).toEqual(["ana_perez@rollo.test"]);
    expect(await by("anita")).toEqual(["ana_perez@rollo.test"]);
    expect(await by("%")).toEqual([]);
    expect(await by("a_a")).toEqual([]);
  });

  it("rejects an unknown sort and a plain user", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/users?sort=badge", { token: su.token })).status).toBe(400);
    const { token } = await signUp();
    expect((await api("GET", "/admin/users", { token })).status).toBe(404);
  });
});

describe("GET /admin/users/:id", () => {
  it("returns the user with their active rollos and states", async () => {
    const su = await makeSuperadmin();
    const { tripId, adminToken, name } = await newTrip({ startsAt: Date.now() + 86_400_000, endsAt: Date.now() + 2 * 86_400_000 });
    const me = (await api("GET", "/me", { token: adminToken })).body.user;
    const r = await api("GET", `/admin/users/${me.id}`, { token: su.token });
    expect(r.status).toBe(200);
    expect(r.body.trips).toEqual([{ id: tripId, name, role: "admin", state: "upcoming" }]);
    expect((await api("GET", "/admin/users/nope", { token: su.token })).status).toBe(404);
  });
});
```
(Adjust `newTrip` option names to the ones `test/helpers.ts` accepts.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/admin-users.test.ts --maxWorkers=2`
Expected: FAIL (404 on `/admin/users`).

- [ ] **Step 3: Implement** repository (Drizzle via `orm(db)`; escape `q` with `q.replace(/[\\%_]/g, "\\$&")` and `like(col, \`%${esc}%\`)` + `sql\`ESCAPE '\\'\``; `lower()` on both sides), service (`listUsers(db, query)` builds the `PageSpec` and calls `paginate`; `getUser(db, id, now)`), controller (parse query with `PageQuerySchema`, zod failure → 400 `{ error: "Parámetros inválidos" }`), routes with `adminAuth({ session: true })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/admin-users.test.ts test/admin.test.ts --maxWorkers=2 && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/admin test/admin-users.test.ts
git commit -m "Lista paginada y detalle de usuarios en /admin/users"
```

---

### Task 10: Docs, contract check and PR

**Files:**
- Modify: `CLAUDE.md` ("Estado" + secrets: `CF_ANALYTICS_TOKEN`; a short "Backoffice" paragraph pointing to `docs/decisiones/0002-backoffice.md` and listing the `/admin/*` routes and credentials), `docs/moderacion.md` (note that `GET /admin/reports` also works with a superadmin session), `docs/decisiones/0002-backoffice.md` (status → `aceptada`), `wrangler.jsonc` comments (secrets list).

- [ ] **Step 1: Prove the public contract did not change**

Run: `npm run openapi && git status --short openapi.json`
Expected: `openapi.json` unchanged (empty status line). Then `npx vitest run test/openapi.test.ts --maxWorkers=2` → PASS.

- [ ] **Step 2: Run every test file touched by this plan once more**

Run: `npx vitest run test/app-role.test.ts test/admin-session.test.ts test/admin.test.ts test/paging.test.ts test/degraded-mode.test.ts test/degraded-blocks.test.ts test/metrics.test.ts test/cf-usage.test.ts test/admin-users.test.ts --maxWorkers=2 && npm run typecheck && npm run db:check-schema`
Expected: all PASS.

- [ ] **Step 3: Update the docs** listed above.

- [ ] **Step 4: Commit and open the PR**

```bash
git add CLAUDE.md docs wrangler.jsonc
git commit -m "Docs: backoffice, secrets y rutas /admin"
git push -u origin feature/backoffice
gh pr create --base develop --title "Backoffice: rol superadmin, métricas, uso de Cloudflare, modo degradado y /admin/users" --body "Implementa el backend de docs/decisiones/0002-backoffice.md (§1–§7). Sin cambios en openapi.json.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Deploy order (spec §10), done by Juani after merge to `main`: `npm run db:migrate:remote` → `npx wrangler secret put CF_ANALYTICS_TOKEN` → `npm run deploy` → `UPDATE users SET app_role='superadmin' WHERE email='...'` via `wrangler d1 execute rollo --remote --command "..."`.
