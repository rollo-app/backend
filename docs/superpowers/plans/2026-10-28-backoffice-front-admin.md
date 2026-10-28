# Backoffice `front-admin` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js panel at `Rollo/front-admin`, deployed on Vercel, where a superadmin logs in with the app's email code and sees the dashboard (app totals, 30-day chart, Cloudflare usage, degraded-mode switch) and a paginated users list.

**Architecture:** Next.js App Router with a BFF: the backend session token lives in an `httpOnly` cookie, Server Components and Server Actions call `rollo-api` from the server (`lib/api.ts`), the browser never talks to the backend. shadcn/ui on a theme that mirrors the iOS look of the app ("C" style). Framework components (`AppShell`, `PageHeader`, `StatCard`, `UsageMeter`, `ChartCard`, `DataTable`) are what future sections reuse.

**Tech Stack:** Next.js (latest stable, App Router, TypeScript, Node runtime), Tailwind, shadcn/ui (+ `chart` on Recharts, `table` on TanStack Table, `sheet`, `alert-dialog`), zod, vitest + @testing-library/react + jsdom.

**Spec:** `Rollo/backend/docs/decisiones/0002-backoffice.md` §8 (and §2, §5, §7 for the endpoints it consumes). Requires the backend plan (`2026-10-28-backoffice-backend.md`) merged or running locally on `http://localhost:8787`.

## Global Constraints

- New git repo `rollo-app/front-admin` in `Rollo/front-admin`; `develop` default, `main` production. Commits in Spanish; code, tests and file names in English; UI copy in rioplatense Spanish.
- Only env var: `BACKEND_URL` (server-only). No `NEXT_PUBLIC_*`. `.env.local` → `BACKEND_URL=http://localhost:8787`.
- Cookie: name `rollo_admin_session`, `httpOnly`, `secure` (not in dev), `sameSite: "lax"`, `path: "/"`, `maxAge: 30 days`.
- Any backend `404` on `/admin/*` from the panel = "sin acceso o sesión vencida": clear the cookie, redirect to `/login`.
- Theme tokens (spec §8): background `#F2F2F7` / dark `#000000`; card `#FFFFFF` / dark `#1C1C1E`; primary `#3155F5` / dark `#5C7CFF`; destructive `#FF3B30`; success `#34C759`; warning `#FF9F0A`; separator `#3C3C434A`; radius `14px`; font `-apple-system, system-ui, sans-serif`. Dark mode via `prefers-color-scheme`.
- Usage thresholds: green `< 60%`, amber `60–85%`, red `> 85%`. "Actualizado hace X min" turns amber when `> 20 min`.
- Days are UTC and labeled "(UTC)" (spec §4).
- Tests: `npx vitest run <file>`; keep them to the framework components and the login logic (spec §9). No e2e.

## Review Focus

1. Opening any `/` route without the cookie must land on `/login`, and `/login` with a valid cookie must go to `/` — test in Task 3.
2. A user with a valid session but `appRole: "user"` must be logged out on the backend (`POST /auth/logout`) and see "No tenés acceso a este panel" — test in Task 3.
3. `DataTable` must keep `q`, `sort`, `order`, `pageSize` in the URL when changing page, and reset `page` to 1 when `q` changes — test in Task 5.
4. `UsageMeter` with `usage: null` (no token configured) must render "Sin datos de Cloudflare" instead of 0% — test in Task 6.
5. The degraded-mode button must not flip the switch without the confirmation dialog, and must show the backend error text on failure — test in Task 7.

---

### Task 1: Scaffold, theme and test setup

**Files:**
- Create: the Next.js project (`npx create-next-app@latest front-admin --ts --tailwind --eslint --app --src-dir --import-alias "@/*"`), `components.json` (shadcn), `src/app/globals.css` (tokens), `vitest.config.ts`, `src/test/setup.ts`, `.env.example`, `README.md`, `.gitignore` (+ `.env.local`)
- Test: `src/app/globals.test.ts`

**Interfaces:**
- Produces: shadcn initialized (`npx shadcn@latest init`, style "new-york", base color neutral, CSS variables), components added: `button card input label table sheet alert-dialog badge skeleton separator chart dropdown-menu`. `src/lib/cn.ts` re-exports shadcn's `cn`. `npm test` runs vitest with jsdom.

- [ ] **Step 1: Create the project and init git**

Run from `Rollo/`: `npx create-next-app@latest front-admin ...` (flags above), then `cd front-admin && git init -b develop && git add -A && git commit -m "Proyecto Next.js inicial"`.

- [ ] **Step 2: Init shadcn and add the components listed above**

Run: `npx shadcn@latest init -d && npx shadcn@latest add button card input label table sheet alert-dialog badge skeleton separator chart dropdown-menu`

- [ ] **Step 3: Write the failing token test**

```ts
// src/app/globals.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

describe("theme tokens", () => {
  it("defines the Rollo palette for light and dark", () => {
    expect(css).toMatch(/--primary:\s*#3155F5/i);
    expect(css).toMatch(/--background:\s*#F2F2F7/i);
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toMatch(/--primary:\s*#5C7CFF/i);
    expect(css).toMatch(/--radius:\s*14px/);
  });
});
```

- [ ] **Step 4: Add vitest** (`npm i -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`), `vitest.config.ts` with `environment: "jsdom"`, `setupFiles: ["src/test/setup.ts"]` (imports `@testing-library/jest-dom/vitest`), `"test": "vitest run"` in `package.json`.

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/app/globals.test.ts`
Expected: FAIL (tokens still shadcn defaults).

- [ ] **Step 6: Write the tokens in `globals.css`** (`:root` light values, `@media (prefers-color-scheme: dark)` dark values, every value from Global Constraints as shadcn variables: `--background`, `--card`, `--primary`, `--primary-foreground: #FFFFFF`, `--destructive`, `--border`, `--radius`, plus `--success` and `--warning`), and set `font-family` on `body`.

- [ ] **Step 7: Run tests and the build**

Run: `npx vitest run src/app/globals.test.ts && npm run build`
Expected: PASS; build OK.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "Tema de Rollo (estilo iOS) sobre shadcn y setup de tests"
```

---

### Task 2: Backend client and session cookie (`lib/api.ts`, `lib/session.ts`)

**Files:**
- Create: `src/lib/api.ts`, `src/lib/session.ts`, `src/lib/types.ts`
- Test: `src/lib/api.test.ts`

**Interfaces:**
- Produces in `src/lib/types.ts` (mirror of the backend `/admin/*` shapes): `AdminMe`, `Page<T>`, `AdminUser`, `AdminUserDetail`, `MetricsResponse`, `UsageResponse`, `DegradedMode`.
- Produces in `src/lib/session.ts`: `SESSION_COOKIE = "rollo_admin_session"`, `getSessionToken(): Promise<string | null>` (from `next/headers` `cookies()`), `setSessionCookie(token: string)`, `clearSessionCookie()`.
- Produces in `src/lib/api.ts`:
```ts
export class ApiError extends Error { constructor(readonly status: number, message: string) }
export class NoAccessError extends ApiError {}  // status 404 from /admin/*
export async function backendFetch<T>(path: string, init?: { method?: string; body?: unknown; token?: string | null }): Promise<T>;
// Uses process.env.BACKEND_URL; JSON in/out; 204 → undefined; non-2xx → ApiError(status, body.error ?? "Error"); 404 on a path starting with "/admin" → NoAccessError.
export const adminApi = {
  me: (token) => backendFetch<AdminMe>("/admin/me", { token }),
  metrics: (token, days = 30) => ..., usage: (token) => ..., degraded: (token) => ..., setDegraded: (token, on: boolean) => ...,
  users: (token, query: URLSearchParams) => backendFetch<Page<AdminUser>>(`/admin/users?${query}`, { token }),
  user: (token, id) => ...,
};
export const authApi = { start: (email) => ..., verify: (email, code) => backendFetch<{ token: string }>(...), logout: (token) => ... };
```

- [ ] **Step 1: Write the failing tests** (mock `globalThis.fetch` with `vi.fn()`)

```ts
// src/lib/api.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, NoAccessError, backendFetch } from "./api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.restoreAllMocks());
process.env.BACKEND_URL = "http://backend.test";

describe("backendFetch", () => {
  it("sends the bearer token and JSON body to BACKEND_URL", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { ok: 1 }));
    await expect(backendFetch("/admin/me", { token: "t", method: "PUT", body: { on: true } })).resolves.toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://backend.test/admin/me");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer t");
    expect(init!.body).toBe(JSON.stringify({ on: true }));
  });
  it("maps a 404 under /admin to NoAccessError and other errors to ApiError with the backend message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(404, { error: "No encontrado" })).mockResolvedValueOnce(json(503, { error: "Rollo está en mantenimiento, probá más tarde" }));
    await expect(backendFetch("/admin/users")).rejects.toBeInstanceOf(NoAccessError);
    await expect(backendFetch("/trips")).rejects.toMatchObject({ status: 503, message: "Rollo está en mantenimiento, probá más tarde" } satisfies Partial<ApiError>);
  });
  it("returns undefined on 204", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(backendFetch("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/api.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `types.ts`, `api.ts`, `session.ts`** per Interfaces (`session.ts` is server-only: add `import "server-only"`).

- [ ] **Step 4: Run tests** — `npx vitest run src/lib/api.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit** — `git add src/lib && git commit -m "Cliente del backend y cookie de sesión del panel"`

---

### Task 3: Login flow and route protection

**Files:**
- Create: `src/app/login/page.tsx`, `src/app/login/actions.ts`, `src/app/login/login-form.tsx`, `src/middleware.ts`, `src/app/(panel)/layout.tsx` (minimal, Task 4 fills it), `src/app/(panel)/page.tsx` (placeholder "Dashboard"), `src/lib/auth.ts`
- Test: `src/app/login/actions.test.ts`

**Interfaces:**
- Produces Server Actions in `src/app/login/actions.ts`:
  - `startLogin(prev: LoginState, form: FormData): Promise<LoginState>` → on success `{ step: "code", email }`; on `ApiError` `{ step: "email", error: message }`.
  - `verifyLogin(prev, form): Promise<LoginState>` → `authApi.verify` → `adminApi.me(token)`; `appRole === "superadmin"` → `setSessionCookie(token)` + `redirect("/")`; otherwise `authApi.logout(token)` and `{ step: "code", email, error: "No tenés acceso a este panel" }`; wrong code → `{ step: "code", email, error: message }`.
  - `logout(): Promise<void>` → `authApi.logout(token)` (ignore errors) + `clearSessionCookie()` + `redirect("/login")`.
  - `type LoginState = { step: "email" | "code"; email?: string; error?: string }`.
- Produces `src/lib/auth.ts`: `requireSession(): Promise<string>` for Server Components: token from cookie, `adminApi.me` check; on missing cookie or `NoAccessError` → `clearSessionCookie()` + `redirect("/login")`.
- Produces `src/middleware.ts`: no cookie and path not `/login` → redirect `/login`; cookie present and path `/login` → redirect `/` (cheap presence check only; `requireSession` does the real one).

- [ ] **Step 1: Write the failing tests** (mock `@/lib/api`, `@/lib/session`, `next/navigation`)

```ts
// src/app/login/actions.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }) }));
vi.mock("@/lib/session", () => ({ setSessionCookie: vi.fn(), clearSessionCookie: vi.fn(), getSessionToken: vi.fn() }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<any>()), authApi: { start: vi.fn(), verify: vi.fn(), logout: vi.fn() }, adminApi: { me: vi.fn() } }));
import { ApiError, NoAccessError, adminApi, authApi } from "@/lib/api";
import { setSessionCookie } from "@/lib/session";
import { startLogin, verifyLogin } from "./actions";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
beforeEach(() => vi.clearAllMocks());

describe("login actions", () => {
  it("startLogin moves to the code step", async () => {
    (authApi.start as any).mockResolvedValue(undefined);
    expect(await startLogin({ step: "email" }, form({ email: "su@rollo.test" }))).toEqual({ step: "code", email: "su@rollo.test" });
  });
  it("startLogin shows the backend error", async () => {
    (authApi.start as any).mockRejectedValue(new ApiError(429, "Esperá un momento antes de pedir otro código"));
    expect(await startLogin({ step: "email" }, form({ email: "su@rollo.test" }))).toMatchObject({ step: "email", error: "Esperá un momento antes de pedir otro código" });
  });
  it("verifyLogin sets the cookie and redirects a superadmin", async () => {
    (authApi.verify as any).mockResolvedValue({ token: "tok" });
    (adminApi.me as any).mockResolvedValue({ id: "1", email: "su@rollo.test", name: "Juani", appRole: "superadmin" });
    await expect(verifyLogin({ step: "code", email: "su@rollo.test" }, form({ code: "ABC234" }))).rejects.toThrow("REDIRECT:/");
    expect(setSessionCookie).toHaveBeenCalledWith("tok");
  });
  it("verifyLogin logs out a plain user and says no access", async () => {
    (authApi.verify as any).mockResolvedValue({ token: "tok" });
    (adminApi.me as any).mockRejectedValue(new NoAccessError(404, "No encontrado"));
    expect(await verifyLogin({ step: "code", email: "u@rollo.test" }, form({ code: "ABC234" }))).toMatchObject({ step: "code", error: "No tenés acceso a este panel" });
    expect(authApi.logout).toHaveBeenCalledWith("tok");
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/app/login/actions.test.ts` → FAIL.

- [ ] **Step 3: Implement `actions.ts`, `lib/auth.ts`, `middleware.ts`**, the login page (`Card` centered on the grouped background: title "Rollo · Panel", email form → code form with `useActionState`, inline error in `--destructive`), and the `(panel)` placeholder layout/page that calls `requireSession()`.

- [ ] **Step 4: Run tests and smoke it against the local backend**

Run: `npx vitest run src/app/login/actions.test.ts && npx tsc --noEmit`, then `npm run dev` with the backend on `:8787` (`npm run dev` in `backend`, superadmin set with `wrangler d1 execute rollo --local --command "UPDATE users SET app_role='superadmin' WHERE email='...'"`): log in with the code printed in the backend console; a plain user sees "No tenés acceso a este panel".
Expected: PASS; both manual paths behave as described.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Login con el código por email y protección de rutas"`

---

### Task 4: `AppShell`, `PageHeader`, sidebar navigation

**Files:**
- Create: `src/components/shell/app-shell.tsx`, `src/components/shell/sidebar.tsx`, `src/components/shell/page-header.tsx`, `src/components/shell/nav-items.ts`
- Modify: `src/app/(panel)/layout.tsx`
- Test: `src/components/shell/sidebar.test.tsx`

**Interfaces:**
- Produces `NAV_ITEMS: { href: string; label: string; soon?: boolean }[]` = Dashboard `/`, Usuarios `/users`, Rollos `/rollos` (soon), Fotos `/photos` (soon), Denuncias `/reports` (soon).
- `Sidebar({ email, currentPath }: { email: string; currentPath: string })`: active item highlighted with `--primary`, `soon` items disabled with a "próximamente" `Badge`, footer with the email and a "Salir" button bound to the `logout` action. `AppShell({ email, children })`: sidebar fixed on `md+`, inside a `Sheet` behind a menu button below `md`. `PageHeader({ title, subtitle?, actions? })`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/shell/sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/login/actions", () => ({ logout: vi.fn() }));
import { Sidebar } from "./sidebar";

describe("Sidebar", () => {
  it("marks the current section, disables the coming-soon ones and shows the email", () => {
    render(<Sidebar email="su@rollo.test" currentPath="/users" />);
    expect(screen.getByRole("link", { name: "Usuarios" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Rollos").closest("a, button, span")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("próximamente")).toHaveLength(3);
    expect(screen.getByText("su@rollo.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salir" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/shell/sidebar.test.tsx` → FAIL.

- [ ] **Step 3: Implement the four files and use `AppShell` in `(panel)/layout.tsx`** (layout calls `requireSession()`, then `adminApi.me(token)` for the email; `currentPath` via a small client wrapper on `usePathname()`).

- [ ] **Step 4: Run tests** — `npx vitest run src/components/shell/sidebar.test.tsx && npx tsc --noEmit` → PASS. Check `npm run dev` at phone width: the sidebar collapses into the sheet.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Marco del panel: sidebar, AppShell y PageHeader"`

---

### Task 5: `DataTable` and the Users list + detail

**Files:**
- Create: `src/components/data/data-table.tsx`, `src/components/data/pagination.tsx`, `src/components/data/search-box.tsx`, `src/components/data/empty-state.tsx`, `src/components/data/error-state.tsx`, `src/lib/page-params.ts`, `src/app/(panel)/users/page.tsx`, `src/app/(panel)/users/columns.tsx`, `src/app/(panel)/users/[id]/page.tsx`
- Test: `src/lib/page-params.test.ts`, `src/components/data/data-table.test.tsx`

**Interfaces:**
- Consumes `Page<T>`, `adminApi.users`, `adminApi.user` (Task 2).
- Produces `src/lib/page-params.ts`: `parsePageParams(sp: Record<string, string | string[] | undefined>, defaults?: { sort?: string }): { page: number; pageSize: number; sort?: string; order: "asc" | "desc"; q?: string }` (page ≥ 1 default 1, pageSize ∈ {25, 50, 100} default 25) and `buildPageHref(pathname, current, patch: Partial<...>): string` — setting `q` or `sort`/`order` or `pageSize` resets `page` to 1; every other key is preserved.
- Produces `DataTable<T>({ page: Page<T>, columns: ColumnDef<T>[], pathname, params, searchPlaceholder, rowHref?: (row: T) => string, emptyText })`: TanStack table (manual pagination/sorting), sortable headers link to `buildPageHref(... { sort, order })`, search box submits `q` via GET, footer "Mostrando A–B de N" + prev/next + page size select, each row a link when `rowHref` is given.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/page-params.test.ts
import { describe, expect, it } from "vitest";
import { buildPageHref, parsePageParams } from "./page-params";

describe("page params", () => {
  it("parses with defaults and clamps page size to the allowed set", () => {
    expect(parsePageParams({})).toEqual({ page: 1, pageSize: 25, order: "desc" });
    expect(parsePageParams({ page: "3", pageSize: "40", q: " ana ", sort: "name", order: "asc" })).toEqual({ page: 3, pageSize: 25, q: "ana", sort: "name", order: "asc" });
  });
  it("keeps the other params and resets page on q, sort or pageSize changes", () => {
    const cur = { page: 3, pageSize: 50, order: "desc" as const, q: "ana", sort: "createdAt" };
    expect(buildPageHref("/users", cur, { page: 4 })).toBe("/users?page=4&pageSize=50&sort=createdAt&order=desc&q=ana");
    expect(buildPageHref("/users", cur, { q: "beto" })).toBe("/users?page=1&pageSize=50&sort=createdAt&order=desc&q=beto");
    expect(buildPageHref("/users", cur, { sort: "name", order: "asc" })).toBe("/users?page=1&pageSize=50&sort=name&order=asc&q=ana");
  });
});
```
```tsx
// src/components/data/data-table.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./data-table";

const page = { items: [{ id: "1", email: "a@x" }, { id: "2", email: "b@x" }], page: 2, pageSize: 25, total: 57 };
const columns = [{ accessorKey: "email", header: "Email", meta: { sortKey: "email" } }];
const params = { page: 2, pageSize: 25, order: "desc" as const };

describe("DataTable", () => {
  it("shows the range, links prev/next and sortable headers, and rows as links", () => {
    render(<DataTable page={page} columns={columns as any} pathname="/users" params={params} searchPlaceholder="Buscar" rowHref={(r: any) => `/users/${r.id}`} emptyText="Nada" />);
    expect(screen.getByText("Mostrando 26–50 de 57")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute("href", "/users?page=1&pageSize=25&order=desc");
    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute("href", "/users?page=3&pageSize=25&order=desc");
    expect(screen.getByRole("link", { name: /Email/ })).toHaveAttribute("href", "/users?page=1&pageSize=25&sort=email&order=asc");
    expect(screen.getByRole("link", { name: "a@x" })).toHaveAttribute("href", "/users/1");
  });
  it("renders the empty text when there are no rows", () => {
    render(<DataTable page={{ ...page, items: [], total: 0 }} columns={columns as any} pathname="/users" params={params} searchPlaceholder="Buscar" emptyText="No hay usuarios" />);
    expect(screen.getByText("No hay usuarios")).toBeInTheDocument();
  });
});
```
(Header sort link: clicking a column not currently sorted goes `asc`; the sorted column toggles.)

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/lib/page-params.test.ts src/components/data/data-table.test.tsx` → FAIL.

- [ ] **Step 3: Implement `page-params.ts`, the data components, and the users pages**: `/users` = `PageHeader("Usuarios")` + `DataTable` over `adminApi.users(token, params)` with columns Email, Nombre (`name` + `@username` muted), Rol (`Badge` "superadmin" only when set), Rollos (`tripCount`), Fotos (`mediaCount`), Último acceso (`lastSeenAt` relative, "nunca" when null), Alta (`createdAt` date). `/users/[id]` = `PageHeader(name ?? email)` + a `Card` with the fields + a plain table of `trips` (Nombre, Rol en el rollo, Estado with labels `Por empezar | En curso | Terminado | Revelado`). Backend errors render `ErrorState` with the message.

- [ ] **Step 4: Run tests and smoke** — `npx vitest run src/lib/page-params.test.ts src/components/data/data-table.test.tsx && npx tsc --noEmit` → PASS; in `npm run dev` search, sort and page through the seeded users (`npm run seed` in `backend`).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "DataTable paginada y sección Usuarios"`

---

### Task 6: `StatCard`, `UsageMeter`, `ChartCard`

**Files:**
- Create: `src/components/data/stat-card.tsx`, `src/components/data/usage-meter.tsx`, `src/components/data/chart-card.tsx`, `src/lib/format.ts`
- Test: `src/components/data/usage-meter.test.tsx`, `src/lib/format.test.ts`

**Interfaces:**
- Produces `src/lib/format.ts`: `formatInt(n)` (`1.284`, es-AR grouping), `formatPct(value, limit)` (integer percent), `formatBytes(n)` (`2,1 GB`), `relativeMinutes(fromMs, nowMs)` (`"hace 3 min"`, `"hace 2 h"`), `formatUtcDay("2026-10-27")` → `"27/10 (UTC)"`.
- `StatCard({ label, value: number, hint?: string })`. `UsageMeter({ label, value, limit, format?: (n) => string })`: bar + `value / limit` text + percent, color by threshold (`data-level="ok" | "warn" | "danger"`); `UsageMeter.Empty({ label })` renders "Sin datos de Cloudflare". `ChartCard({ title, series: { day: string; values: Record<string, number> }[], keys: { key, label, color }[] })`: shadcn `ChartContainer` + Recharts `LineChart`, x labels `DD/MM`, axis title "(UTC)".

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/data/usage-meter.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageMeter } from "./usage-meter";

describe("UsageMeter", () => {
  it.each([[41_200, "ok"], [78_000, "warn"], [90_000, "danger"]])("colors %i of 100k as %s", (value, level) => {
    render(<UsageMeter label="Requests" value={value} limit={100_000} />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-level", level);
  });
  it("shows value, limit and percent", () => {
    render(<UsageMeter label="D1 lecturas" value={3_900_000} limit={5_000_000} />);
    expect(screen.getByText("3.900.000 / 5.000.000")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });
  it("renders the empty state", () => {
    render(<UsageMeter.Empty label="Requests" />);
    expect(screen.getByText("Sin datos de Cloudflare")).toBeInTheDocument();
  });
});
```
```ts
// src/lib/format.test.ts
import { describe, expect, it } from "vitest";
import { formatBytes, formatInt, formatUtcDay, relativeMinutes } from "./format";
describe("format", () => {
  it("formats numbers the Argentine way", () => {
    expect(formatInt(1284)).toBe("1.284");
    expect(formatBytes(2_100_000_000)).toBe("2,1 GB");
    expect(relativeMinutes(0, 3 * 60_000)).toBe("hace 3 min");
    expect(relativeMinutes(0, 2 * 3_600_000)).toBe("hace 2 h");
    expect(formatUtcDay("2026-10-27")).toBe("27/10 (UTC)");
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/components/data/usage-meter.test.tsx src/lib/format.test.ts` → FAIL.

- [ ] **Step 3: Implement the three components and `format.ts`** per Interfaces (`Intl.NumberFormat("es-AR")`).

- [ ] **Step 4: Run tests** — same command → PASS; `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "StatCard, UsageMeter y ChartCard"`

---

### Task 7: Dashboard page and degraded-mode switch

**Files:**
- Create: `src/app/(panel)/dashboard.actions.ts`, `src/app/(panel)/degraded-switch.tsx`
- Modify: `src/app/(panel)/page.tsx`
- Test: `src/app/(panel)/degraded-switch.test.tsx`

**Interfaces:**
- Consumes `adminApi.metrics`, `adminApi.usage`, `adminApi.degraded`, `adminApi.setDegraded` (Task 2); `StatCard`, `UsageMeter`, `ChartCard` (Task 6).
- Produces Server Action `setDegradedMode(on: boolean): Promise<{ ok: true; state: DegradedMode } | { ok: false; error: string }>` (calls `revalidatePath("/")` on success).
- Produces `DegradedSwitch({ state: DegradedMode })` (client): shows "Modo degradado: apagado/prendido", "cambiado por {email} el {fecha}" when known, a `Button` "Activar" / "Desactivar" that opens an `AlertDialog` ("¿Activar el modo degradado?" + what it blocks, per spec §5) and only calls the action on confirm; shows `error` inline.
- Dashboard page composition (spec §8, mockup B): `PageHeader("Dashboard", subtitle: "al cierre del {formatUtcDay(latestDay)}")`; three `StatCard` (Usuarios = `users_total`, hint `+N esta semana` = sum of `users_new` over the last 7 days; Rollos = `trips_total`, hint `N abiertos ahora` = latest `trips_open`; Fotos = `media_total`, hint `+N esta semana`); `ChartCard("Últimos 30 días")` with keys `users_new` "Usuarios nuevos", `media_new` "Fotos subidas", `trips_new` "Rollos creados"; a `Card` "Uso de Cloudflare (hoy, UTC)" with five `UsageMeter` (`workers_requests` "Requests", `d1_rows_read` "D1 lecturas", `d1_rows_written` "D1 escrituras", `r2_class_a` "R2 op. A (mes)", `r2_class_b` "R2 op. B (mes)") plus one for storage (`storage.usedBytes / limitBytes`, `formatBytes`), and "Actualizado {relativeMinutes(fetchedAt)}" amber when > 20 min; `UsageMeter.Empty` for each when `usage` is null; `DegradedSwitch` beside it. With no metrics yet (`latestDay === null`) the stat cards show "—" and the chart an `EmptyState("Todavía no hay métricas: el cron las guarda cada día a las 00:05 UTC")`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/(panel)/degraded-switch.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./dashboard.actions", () => ({ setDegradedMode: vi.fn() }));
import { setDegradedMode } from "./dashboard.actions";
import { DegradedSwitch } from "./degraded-switch";

beforeEach(() => vi.clearAllMocks());

describe("DegradedSwitch", () => {
  it("asks for confirmation before activating", async () => {
    (setDegradedMode as any).mockResolvedValue({ ok: true, state: { on: true, updatedAt: 1, updatedBy: { id: "1", email: "su@rollo.test" } } });
    render(<DegradedSwitch state={{ on: false, updatedAt: null, updatedBy: null }} />);
    await userEvent.click(screen.getByRole("button", { name: "Activar" }));
    expect(setDegradedMode).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sí, activar" }));
    expect(setDegradedMode).toHaveBeenCalledWith(true);
  });
  it("shows the backend error", async () => {
    (setDegradedMode as any).mockResolvedValue({ ok: false, error: "No encontrado" });
    render(<DegradedSwitch state={{ on: true, updatedAt: 1, updatedBy: { id: "1", email: "su@rollo.test" } }} />);
    expect(screen.getByText(/cambiado por su@rollo.test/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Desactivar" }));
    await userEvent.click(screen.getByRole("button", { name: "Sí, desactivar" }));
    expect(await screen.findByText("No encontrado")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run "src/app/(panel)/degraded-switch.test.tsx"` → FAIL.

- [ ] **Step 3: Implement the action, the switch and the dashboard page** per Interfaces (page fetches the three endpoints with `Promise.all`).

- [ ] **Step 4: Run tests and smoke** — `npx vitest run "src/app/(panel)/degraded-switch.test.tsx" && npx tsc --noEmit && npm run build` → PASS. In `npm run dev`: with the backend's cron run once (`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"` with `npm run dev -- --test-scheduled`), the stat cards and chart show numbers; toggle degraded mode and confirm the backend answers 503 on `POST /trips`.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Dashboard: totales, gráfico de 30 días, uso de Cloudflare y modo degradado"`

---

### Task 8: README, Vercel and first deploy

**Files:**
- Modify: `README.md` (how to run with the local backend, env vars, how to make a superadmin, deploy), `.env.example`
- Create: `CLAUDE.md` (short: stack, BFF rule, theme tokens, "a new section = `PageHeader` + `DataTable` over a `paginate` endpoint", test command)

- [ ] **Step 1: Write the docs** listed above.

- [ ] **Step 2: Push the repo and create `main`**

```bash
gh repo create rollo-app/front-admin --private --source . --push
git branch main && git push -u origin main
gh repo edit rollo-app/front-admin --default-branch develop
```

- [ ] **Step 3: Connect Vercel** (Juani, in the Vercel UI or `vercel link`): import `rollo-app/front-admin`, production branch `main`, env `BACKEND_URL=https://rollo-api.juanifraga.com` for Production and Preview. Deploy previews come from `develop` and PRs.

- [ ] **Step 4: Verify production**: open the Vercel URL, log in as the superadmin, dashboard and `/users` load; a plain user is refused.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Docs y configuración de deploy"` and push `develop`.
