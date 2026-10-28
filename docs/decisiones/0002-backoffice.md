# 0002 — Backoffice: panel web de administración (`front-admin`)

- **Estado:** propuesta (en revisión con Juani)
- **Fecha:** 28/10/2026
- **Revisar:** cuando se encare la fase 2 (listas de rollos/fotos/denuncias, modo degradado automático, log de auditoría), o si el uso de Cloudflare se acerca al límite gratis antes

Este documento cubre dos repos: el backend (`rollo-app/backend`) y un repo nuevo, `front-admin`. Es la descripción
completa de la primera entrega; de acá sale el plan de implementación.

## Contexto y por qué

Rollo corre en el plan gratis de Cloudflare (Workers, D1, R2) y de Resend. Hoy la única forma de saber cómo
viene el uso es entrar al dashboard de Cloudflare, y la única forma de actuar sobre la app (borrar una foto
denunciada, borrar una cuenta) es `curl` con `ADMIN_TOKEN` (`docs/moderacion.md`). No hay forma de ver cuántos
usuarios hay, cuántos rollos, cuántas fotos, ni cómo evoluciona eso en el tiempo.

Se quiere un **panel web** para:

1. Ver de un vistazo **cómo venimos contra los límites gratis** de Cloudflare, y poder **frenar lo que gasta** si
   nos estamos por pasar.
2. Ver **estadísticas generales** de la app (usuarios, rollos, fotos) y su **tendencia**, para sacar conclusiones a
   futuro.
3. Tener una **base uniforme** (diseño, componentes, paginado) sobre la que agregar secciones nuevas sin
   rediseñar cada vez.

## Objetivos, no objetivos, anti-objetivos

**Objetivos de esta entrega**

- Rol global `superadmin` que habilita el panel.
- Login al panel con el mismo email + código de la app.
- Dashboard: totales de la app, gráfico de 30 días, uso de Cloudflare de hoy, interruptor de modo degradado.
- Modo degradado manual: frena subidas, rollos nuevos y altas nuevas; dejar ver todo.
- Aviso por mail cuando algún límite de Cloudflare pasa el 80%.
- Paquete reutilizable de **queries paginadas** en el backend y una **tabla paginada** reutilizable en el panel.
- Una sección de lista real, **Usuarios**, que estrena ese paquete.
- Sistema de diseño del panel (tokens + componentes de marco) listo para las secciones que vengan.

**No objetivos (quedan para después)**

- Listas de Rollos, Fotos y Denuncias (en el menú quedan como "próximamente").
- Modo degradado automático al cruzar un umbral.
- Log de auditoría de acciones del panel.
- Login con contraseña.
- Editar usuarios desde el panel, borrar cuentas o fotos desde el panel (siguen por `curl`).
- Asignar `superadmin` desde el panel (se hace a mano con SQL, como las insignias).
- Cambios en la app móvil para el modo degradado (la app muestra el `{ error }` que ya sabe mostrar).

**Anti-objetivos (si pasa esto, fracasó aunque funcione)**

- Que el propio panel consuma una parte relevante de la cuota de D1 (lecturas de filas) o de requests.
- Que un usuario normal tenga cualquier camino para entrar al panel o ascenderse.
- Que el panel permita mirar fotos privadas de la gente (solo lo denunciado, y eso es fase 2).
- Que la API de administración aparezca en el `openapi.json` público que consume la app.

## Restricciones

- Backend: Cloudflare Workers + Hono + D1 + R2, módulos en 4 capas, TDD, código en inglés, mensajes al
  usuario en español (`CLAUDE.md`). Las rutas `/admin/*` son un Hono plano fuera del contrato.
- Plan gratis de Cloudflare: 100k requests/día (Workers), 5M filas leídas y 100k escritas/día (D1), 10 GB,
  1M operaciones clase A y 10M clase B por mes (R2). Resend: 100 mails/día.
- Ya existe un rol **por rollo**: `members.role` (`admin` | `member`). No se toca ni se confunde con el global.
- Hay una rama en curso (`feature/rollos-archivar-y-admins`) con la migración `0029`. Las migraciones de este
  trabajo se numeran **después de lo que haya en `develop` al momento de abrir el PR**.
- El panel se despliega en **Vercel** (plan Hobby), no en Cloudflare.

## Decisiones (lo que Juani decidió, tal como lo decidió)

| Tema | Decisión |
|---|---|
| Nombre y ubicación | Carpeta `Rollo/front-admin`, hermana de `backend` y `mobile`. |
| Hosting | Vercel. |
| Framework | React con **Next.js**. |
| Componentes | **shadcn/ui** como base, con un diseño uniforme para las secciones futuras. |
| Rol global | `users.app_role` con valores `'user'` (default) y `'superadmin'`. Se llama así para no confundir con `members.role = 'admin'`. |
| Login al panel | El mismo login por email + código de la app. Un usuario sin `superadmin` ve "No tenés acceso". Contraseña, quizás a futuro. |
| Dashboard | Boceto "B": arriba los totales de la app, después el gráfico de 30 días, abajo el uso de Cloudflare compacto con el interruptor de modo degradado al lado. |
| Modo degradado | Manual (lo prende y apaga el superadmin). Prendido: rechaza subir fotos y videos, crear rollos y registrarse; dejar ver todo. Mensaje: "Rollo está en mantenimiento, probá más tarde". Aviso por mail al 80% de cualquier límite. Automático, fase 2. |
| Paginado | Páginas numeradas (`page`, `pageSize`, `sort`, `order`, `q`) con `total`, resueltas por un helper reutilizable en `backend/src/lib/`. No cursores para el panel. |
| Alcance de listas | Solo **Usuarios** en esta entrega. |
| Look | Opción "C · Como la app": fondo gris agrupado iOS, tarjetas blancas redondeadas, botones píldora, cobalto de Rollo solo en acciones. Modo oscuro automático. |

## Diseño

### 1. Rol `superadmin`

- Migración: `ALTER TABLE users ADD COLUMN app_role TEXT NOT NULL DEFAULT 'user' CHECK (app_role IN ('user', 'superadmin'))`
  (+ `src/db/schema.ts`, y `npm run db:check-schema` tiene que pasar).
- Se asigna a mano: `UPDATE users SET app_role='superadmin' WHERE email='...'`. Ningún endpoint lo escribe.
  `PATCH /me` lo ignora. No sale en `GET /me` ni en `GET /users/{id}` (nada del contrato público cambia).
- `requireUser` carga `app_role` en `user` (sumar la columna al `SELECT` y a `UserRow`).

### 2. Acceso a `/admin/*`

El router `src/modules/admin/` sigue siendo un Hono plano fuera de `openapi.json`. Su middleware pasa a aceptar
**dos** credenciales, y toda falla sigue siendo `404 { error: "No encontrado" }`:

1. `Authorization: Bearer <ADMIN_TOKEN>` (comparación en tiempo constante, como hoy): los `curl` de
   `docs/moderacion.md` siguen funcionando.
2. `Authorization: Bearer <token de sesión>` de un usuario con `app_role = 'superadmin'` (misma búsqueda que
   `requireUser`; una sesión válida de un usuario `user` también da 404).

Se agrega `GET /admin/me` → `{ id, email, name, appRole }` (el panel lo usa justo después del login para
decidir si deja entrar). *(Decisión mía: una sola credencial por request; no se mezclan.)*

**Las rutas destructivas que ya existen (`DELETE /admin/users/:id`, `DELETE /admin/media/:id`) siguen aceptando
solo `ADMIN_TOKEN`**: una sesión de superadmin recibe 404 en ellas. *(Decisión mía: borrar queda fuera de esta
entrega y el panel todavía no tiene auditoría; además la sesión del superadmin es la misma que usa en el
celular. El middleware declara por ruta qué credenciales acepta; `GET /admin/reports` acepta las dos.)*

### 3. Métricas diarias (`metrics_daily`)

El panel **no cuenta filas en vivo**. Un cron guarda una foto por día y el dashboard lee esa tabla.

- Migración: `CREATE TABLE metrics_daily (day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, metric))`.
  `day` es `YYYY-MM-DD` UTC.
- Métricas de la primera entrega (nombres en inglés, son identificadores):
  `users_total`, `users_new` (creados ese día), `trips_total`, `trips_new`, `trips_open` (empezaron y no se
  revelaron: `starts_at <= now AND revealed_at IS NULL AND reveal_at > now`), `trips_revealed_total`,
  `media_total` (`status='uploaded' AND deleted_at IS NULL`), `media_new`, `storage_bytes` (`storageUsage`),
  `active_users` (sesiones con `last_used_at` dentro de ese día: `requireUser` la toca como mucho una vez por
  día, así que aproxima usuarios activos diarios).
- Cuándo: el cron de 5 minutos (`scheduled` en `src/index.ts`) suma `snapshotDailyMetrics(env, now)`: si
  `cron_state.metrics_last_day` es distinto del **día UTC anterior**, calcula las métricas de ese día y las
  escribe (`INSERT OR REPLACE`), y marca el día. Así corre una vez por día, poco después de medianoche UTC, y si
  un run falla el siguiente lo reintenta. Costo: un puñado de `COUNT` por día, nada en cada request.
- Totales "de hoy" en el dashboard: son los del último snapshot, y el panel muestra "al cierre del DD/MM".
  *(Decisión mía: no se recalculan en vivo; evita que abrir el panel lea toda la tabla `media`.)*
- Primera corrida: la migración no rellena historia; el gráfico arranca vacío y se llena día a día. Un script
  opcional (`scripts/backfill-metrics.ts`) puede reconstruir los últimos 30 días desde `created_at`; queda a
  criterio del builder incluirlo o no.

### 4. Uso de Cloudflare

- Fuente: **GraphQL Analytics API** de Cloudflare (`https://api.cloudflare.com/client/v4/graphql`) con un token
  de solo lectura (`Account Analytics: Read`). Secrets nuevos del Worker: `CF_ANALYTICS_TOKEN`. La cuenta es
  `R2_ACCOUNT_ID` (misma cuenta).
- Qué se mide (y contra qué tope, en `src/lib/cf-usage.ts` como constantes):
  - Workers: requests del día UTC del script `rollo-api` / 100.000.
  - D1: filas leídas / 5.000.000 y filas escritas / 100.000, día UTC, de la base `rollo`.
  - R2: operaciones clase A / 1.000.000 y clase B / 10.000.000, mes UTC en curso.
  - R2 almacenamiento: `storageUsage` / `storageLimitBytes` (lo que ya existe; no se consulta a la API).
- **El cron lo trae, el panel no.** Cada 5 minutos el cron consulta la API, guarda el JSON en
  `cron_state` (clave `cf_usage`, con `fetchedAt`) y el panel lo lee de ahí (`GET /admin/usage`). Si la API
  falla, se deja el último valor y el panel muestra "actualizado hace X min" en ámbar si pasó más de 20 min.
  Sin `CF_ANALYTICS_TOKEN`, `usage` viene vacío y el panel lo dice (no rompe nada).
- **Alerta al 80%**: en el mismo run, por cada métrica que cruce el 80% de su tope se manda **un** mail a
  `REPORTS_EMAIL` por métrica y por día UTC (clave `cf_usage_alerted:<metric>:<day>` en `cron_state`), con el
  mismo mecanismo de `sendStorageAlert` (usa un cupo de soporte; si no hay cupo, se loguea). El mail dice la
  métrica, el porcentaje y recuerda que el modo degradado se prende desde el panel. **El almacenamiento de R2
  queda afuera de esta alerta**: ya tiene la suya (`checkStorage`, 70/85/95%) y no se duplica.
- **Zona horaria:** las métricas y los topes diarios son por día UTC (así los cuenta Cloudflare). El panel lo
  muestra tal cual, con la etiqueta "(UTC)" al lado de "al cierre del DD/MM" y en el eje del gráfico, y
  "actualizado hace X min" en relativo. *(Decisión mía: convertir a hora local haría que "hoy" en el panel no
  coincida con el día que Cloudflare está contando.)*

### 5. Modo degradado

- Estado: tabla nueva `app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by_user_id TEXT)`.
  Clave `degraded_mode`, valor `'0'`/`'1'`. *(Decisión mía: tabla propia y no `cron_state`, porque esto lo
  escribe una persona y conviene saber quién y cuándo.)*
- Lectura: `isDegraded(env)` en `src/lib/degraded.ts` con **caché en memoria del isolate de 60 s**: como mucho
  una lectura de D1 por minuto por isolate, no una por request. En tests el caché se puede limpiar.
- Qué frena cuando está en `'1'` (todo con `unavailable("Rollo está en mantenimiento, probá más tarde")` → 503,
  decidido en el **service** de cada módulo, no en un middleware global):
  - `POST /trips/{id}/media` (registrar fotos y videos; los reintentos de un id ya registrado también, para no
    complicar) y `POST /me/avatar`.
  - `POST /trips` (crear rollo).
  - `POST /auth/email/start` **solo para emails sin cuenta** (altas nuevas). Los usuarios existentes siguen
    pudiendo entrar. *(Decisión mía, con un costo: mientras dure el modo degradado, un 503 para un email sin
    cuenta y un 204 para uno con cuenta revela si la cuenta existe. Se acepta porque dura poco y porque bloquear
    también el login de los existentes dejaría afuera al propio superadmin.)*
  - Todo lo demás (ver, bajar, comentar, me gusta, unirse a un rollo) sigue igual.
- Endpoints: `GET /admin/degraded-mode` → `{ on, updatedAt, updatedBy: { id, email } | null }`;
  `PUT /admin/degraded-mode { on: boolean }` → mismo cuerpo. El `updated_by_user_id` es el superadmin de la
  sesión (o `null` si vino con `ADMIN_TOKEN`).

### 6. Paquete de queries paginadas (`src/lib/paging.ts`)

Infra transversal pura, sin SQL de dominio (el SQL de cada lista vive en el repository de su módulo).

- `PageQuerySchema` (zod): `page` entero ≥ 1 (default 1), `pageSize` 1–100 (default 25), `sort` string
  opcional, `order` `'asc' | 'desc'` (default `'desc'`), `q` string opcional (trim, hasta 100 caracteres).
  Los filtros propios de cada lista se suman con `.extend()`.
- `paginate(db, spec, query)` donde `spec` declara: la query base de Drizzle (`orm(db)`), la query de
  conteo, un mapa `sortable: Record<string, Column | SQL>` (lista blanca) y `defaultSort`. Devuelve
  `{ items, page, pageSize, total }`. Un `sort` fuera de la lista blanca es `badRequest`. `items` y `count`
  van en un solo `db.batch`.
- `PageSchema(ItemSchema)` arma el zod de respuesta `{ items, page, pageSize, total }` para reusar en cada
  endpoint (aunque `/admin/*` no va al OpenAPI, los schemas validan y tipan).
- Caché del `total`: **no en esta entrega**; las tablas son chicas. Queda anotado para cuando una lista pase de
  decenas de miles de filas.

### 7. Lista de usuarios

- `GET /admin/users?page&pageSize&sort&order&q` → `PageSchema(AdminUser)`. `AdminUser`:
  `{ id, email, name, username, appRole, badge, createdAt, lastSeenAt, tripCount, mediaCount }`.
  `lastSeenAt` = `MAX(sessions.last_used_at)` (null si nunca entró desde un celular), `tripCount` = membresías
  activas, `mediaCount` = fotos y videos subidos no borrados. Los tres se agregan en la misma consulta (sin N+1).
- `q` busca por `email`, `name` y `username` con `LIKE '%q%'` (case-insensitive). Orden permitido:
  `createdAt` (default, desc), `lastSeenAt`, `name`, `email`.
- `GET /admin/users/{id}` → `AdminUser` + `trips: [{ id, name, role, state }]` (`role` es `members.role`, el
  del rollo; `state` ∈ `upcoming | open | ended | revealed`). Sin fotos, sin avatar grande: solo datos.
- En el panel: `/users` es la tabla paginada con buscador; click en una fila abre `/users/[id]` con el detalle.
  Sin acciones (borrar sigue por `curl`).

### 8. `front-admin` (Next.js en Vercel)

**Repo y despliegue**

- Repo propio `rollo-app/front-admin` (como `backend` y `mobile`), carpeta local `Rollo/front-admin`. Ramas
  como en el backend: `develop` default, `main` producción. Vercel: producción desde `main`, previews desde
  `develop` y PRs. *(Decisión mía.)*
- Next.js (App Router, TypeScript, versión estable actual), Tailwind, shadcn/ui, gráficos con los `Chart` de
  shadcn (Recharts), tabla con TanStack Table vía el `DataTable` de shadcn. Node runtime (no Edge).
- Variables: `BACKEND_URL` (server-only, `https://rollo-api.juanifraga.com`; en local `http://localhost:8787`).
  No hay `NEXT_PUBLIC_*`: el navegador nunca habla con el backend.

**Cómo habla con el backend (BFF)**

- El token de sesión vive en una **cookie `httpOnly`, `Secure`, `SameSite=Lax`** que setea Next.js; el
  navegador no lo ve. Los Server Components y Server Actions leen la cookie y llaman al backend desde el
  servidor de Vercel con `Authorization: Bearer`. Por eso **no hace falta CORS** en el backend.
  *(Decisión mía: evita guardar el token en `localStorage` y no toca el backend para CORS.)*
- Vencimiento de la cookie: 30 días (la sesión del backend dura un año; la cookie la recorta para el panel).
- Un 404 del backend en cualquier llamada `/admin/*` se trata como "sesión vencida o sin acceso": se borra la
  cookie y se vuelve al login.

**Login**

1. `/login`: email → Server Action → `POST /auth/email/start { email }` (sin `linkChallenge`: el mail trae
   solo el código).
2. Pantalla de código → Server Action → `POST /auth/email/verify` → token.
3. Con el token, `GET /admin/me`. Si responde 200 y `appRole === 'superadmin'`, se setea la cookie y se va a
   `/`. Si responde 404, se llama `POST /auth/logout` con ese token (no dejar una sesión colgada) y se muestra
   "No tenés acceso a este panel".
4. "Salir" en el menú: `POST /auth/logout` + borrar cookie.

**Pantallas**

- `/` Dashboard (boceto B):
  - Tres `StatCard`: Usuarios (`users_total`, "+N esta semana" = suma de `users_new` de los últimos 7 días),
    Rollos (`trips_total`, "N abiertos ahora" = `trips_open`), Fotos (`media_total`, "+N esta semana").
    Leyenda "al cierre del DD/MM".
  - `ChartCard` "Últimos 30 días": líneas de `users_new`, `media_new`, `trips_new`.
  - Fila de `UsageMeter` compactos: requests, D1 lecturas, D1 escrituras, R2 operaciones, R2 almacenamiento.
    Verde < 60%, ámbar 60–85%, rojo > 85%. "Actualizado hace X min".
  - Tarjeta "Modo degradado": estado, quién y cuándo lo cambió, botón "Activar" / "Desactivar" con confirmación
    (`AlertDialog`).
- `/users`: `PageHeader` + `DataTable` con buscador, orden por columna, paginador "Mostrando 26–50 de 1.284",
  `pageSize` en la URL (`?page=2&q=...` como query params, para poder compartir el link).
- `/users/[id]`: datos del usuario y su lista de rollos.
- Menú lateral: Dashboard, Usuarios, y Rollos / Fotos / Denuncias deshabilitados con "próximamente". Abajo el
  email del superadmin y "Salir". En pantallas chicas el menú se colapsa (`Sheet`).

**Sistema de diseño (estilo "C")**

- Tokens en `globals.css` como variables de shadcn: fondo `#F2F2F7` (oscuro `#000`), tarjeta `#FFFFFF`
  (oscuro `#1C1C1E`), texto y secundarios del sistema iOS, separador `#3C3C434A`, **primario cobalto
  `#3155F5`** (oscuro `#5C7CFF`) solo en acciones y selecciones, peligro `#FF3B30`, éxito `#34C759`,
  advertencia `#FF9F0A`. Radio base 14 px (tarjetas), botones píldora. Tipografía del sistema
  (`-apple-system, system-ui`). Modo oscuro por `prefers-color-scheme`.
- Componentes de marco (en `components/shell/` y `components/data/`), que toda sección nueva reutiliza:
  `AppShell` (sidebar + contenido), `PageHeader` (título, subtítulo, acciones a la derecha), `StatCard`,
  `UsageMeter`, `ChartCard`, `DataTable` (recibe `{ items, page, pageSize, total }` y las columnas; maneja
  orden, búsqueda y paginado vía URL), `EmptyState`, `ErrorState`.
- Regla para secciones nuevas: una página de lista es `PageHeader` + `DataTable` sobre un endpoint que usa
  `paginate`; nada de colores o tamaños sueltos fuera de los tokens.

### 9. Tests

- Backend (vitest en workerd, TDD como siempre, `--maxWorkers=2`): middleware de `/admin/*` con las dos
  credenciales y con un `user` común (404); `paginate` (orden permitido, orden prohibido, `total`, límites);
  `GET /admin/users` (búsqueda, orden, agregados); snapshot de métricas (corre una vez por día, idempotente);
  modo degradado (cada ruta frenada, caché, `start` con email existente vs nuevo); alerta de uso (una por métrica
  por día, sin token no hace nada).
- `front-admin`: vitest + Testing Library para los componentes de marco (`DataTable`, `UsageMeter`,
  `StatCard`) y para la lógica de login (Server Actions con el backend mockeado). Sin e2e en esta entrega.

### 10. Operación

- Secrets nuevos del Worker: `CF_ANALYTICS_TOKEN`. Vercel: `BACKEND_URL`.
- Orden de salida: migraciones (`npm run db:migrate:remote`) → deploy del backend → `UPDATE users SET
  app_role='superadmin' WHERE email='jfraga@...'` → deploy de `front-admin`.
- Dominio del panel: a definir en Vercel (p. ej. `admin-rollo.juanifraga.com` con CNAME en Cloudflare, o el
  `*.vercel.app` por ahora). No afecta al diseño.

## Lo que queda a criterio del builder

- Las queries GraphQL exactas y cómo mapear los datasets de Cloudflare a las cinco métricas.
- Si incluir o no `scripts/backfill-metrics.ts`.
- Estructura interna de carpetas de `front-admin` más allá de lo indicado, nombres de la cookie y de los Server
  Actions, versión exacta de Next.
- Cómo mockear el backend en los tests del panel.
- Textos secundarios del panel (en español rioplatense, mismo tono que la app).

## Consecuencias

- El backend suma 3 migraciones chicas (`app_role`, `metrics_daily`, `app_settings`), un lib (`paging`,
  `cf-usage`, `degraded`), 2 tareas de cron y 5 endpoints en `/admin/*`. Nada del contrato público cambia.
- `ADMIN_TOKEN` sigue vivo para `curl`; cuando el panel cubra moderación (fase 2) se puede retirar.
- Mientras el modo degradado está prendido, `/auth/email/start` revela si un email tiene cuenta (ver §5).
- Fase 2 pendiente: listas de rollos/fotos/denuncias, modo degradado automático, log de auditoría, contraseña.
