# Rollo — backend

Contexto para Claude Code. Respondé en español rioplatense (voseo), conciso y con recomendaciones directas.

## Qué es Rollo

App iOS para fotos y videos de viaje en grupo. Cada uno saca fotos durante el viaje y **nadie ve nada
—ni siquiera lo propio— hasta el revelado al final**, como un rollo de fotos. Pensada para un viaje con
amigos al sur de Argentina en **enero de 2027**; también para armar fotolibros después.

Decisiones de producto que el backend tiene que respetar:

- **Cuentas con email.** Se entra con email + código de 6 caracteres (A-Z y 2-9 sin ambiguos, vence a los 5 min; en `verify` se ignoran mayúsculas, espacios y guiones) (`/auth/email/*`, mail por Resend) y
  devuelve un token de sesión (365 días desde el último uso: se renueva sola, al usarla, como máximo una vez por día). El nombre (y después el avatar) vive en el perfil (`/me`) y es
  el mismo en todos los rollos, sin ser único. El perfil tiene además una **descripción** opcional (`bio`, `PATCH /me`: se guarda con trim, vacía → `null`, hasta 150 caracteres y 3 renglones; `\r\n` cuenta como un salto) que ven tus amigos (`Friend.bio`). También hay un **username único** (`@juanifraga`, minúsculas, `a-z 0-9 . _`, 3–30; `src/lib/username.ts`). Crear un viaje o unirse requiere nombre y username en el perfil; unirse es solo
  el código de 6 caracteres (idempotente; si el admin te sacó, 403). Cuenta de App Review: `REVIEW_EMAIL`/`REVIEW_CODE`.
- **Amigos** (`src/routes/friends.ts`, `src/lib/friend-code.ts`): la amistad es simétrica y se crea **sin aceptación**
  (`friendships`, par ordenado `user_a < user_b`). `POST /friends/link` genera un código de 8 caracteres (guardado hasheado) que vale
  **1 hora**, es multiuso y se reemplaza al generar otro. `POST /friend-links/claim` (**sin sesión**) devuelve un `claimToken`
  (24 h) para canjear después de registrarse; `POST /friends/redeem` canjea con `code` o `claimToken`. Cualquier falla es el mismo 400
  genérico; 10 fallas por usuario o IP en una hora → 429 (`friend_attempts`). Cualquier miembro suma **a sus amigos** a un rollo
  (`POST /trips/{id}/members`, respuesta por amigo, no si ya se reveló). `members.left_at` (se salió: `DELETE /trips/{id}/members/me`,
  puede volver por código o por amigos, sus fotos quedan) es distinto de `removed_at` (lo sacó el admin: no vuelve por código ni si lo suma un miembro; solo el admin lo puede volver a sumar como amigo, y recupera sus fotos). El admin no puede salirse.
- **Revelado:** automático en `revealAt` o manual por el admin. Antes del revelado el feed devuelve
  **solo metadata** (autor, hora, lugar, epígrafe) para el mapa en vivo y el feed de epígrafes. Nunca
  URLs ni archivos, tampoco los propios.
- **Límite diario por persona**, por tipo, según la fecha local en la zona horaria del viaje
  (default 10 fotos, 3 videos). Las pendientes también cuentan.
- **Videos de hasta 15 s.** Fotos a resolución completa (~4000 px, para imprimir) + thumbnail ~800 px.
  La compresión y el thumbnail los hace el celular, no el Worker.
- **Offline first:** el celular genera el UUID de cada foto y la hora al disparar. Registrar es
  idempotente por ese id, así los reintentos de la cola no duplican ni gastan cupo.

La app vive en [rollo-app/mobile](https://github.com/rollo-app/mobile).

## Stack y arquitectura

- **Cloudflare Workers** + **Hono** (`@hono/zod-openapi`) + **D1** (SQLite) + **R2** (fotos y videos).
- Dominio: `rollo-api.juanifraga.com` (DNS en Cloudflare). Un solo nivel de subdominio a propósito:
  el certificado gratis cubre `*.juanifraga.com`, no `*.rollo.juanifraga.com`.
- **Contrato como fuente única:** `src/schemas.ts` (zod) valida requests, tipa respuestas y genera
  `/openapi.json`. La app genera su cliente desde el `openapi.json` versionado en este repo.
- **Subida directa a R2:** `POST /trips/:id/media` registra y devuelve URLs prefirmadas (aws4fetch,
  15 min) para original y thumb → el celular hace PUT → `POST /media/:id/complete` verifica con HEAD.
- **Descargas** pasan por el Worker (streaming desde R2) y solo después del revelado.
- **Auth:** `Authorization: Bearer <token de sesión>`; en D1 solo se guarda el SHA-256 del token (`sessions`) y del código (`auth_codes`). Un middleware de membresía carga `member`/`trip` en las rutas con `{tripId}`.

```
src/index.ts          app, /openapi.json, /docs, manejo de errores
src/schemas.ts        contrato (zod + OpenAPI)
src/lib/              auth, openapi helpers, r2 (presign), util (fechas, revelado), login-code (códigos), friend-code (amistad)
src/routes/           auth.ts, me.ts, friends.ts, trips.ts, media.ts
migrations/           D1 (se aplican solas en los tests)
test/                 vitest dentro de workerd, con D1 y R2 locales reales
openapi.json          contrato versionado — regenerar con `npm run openapi`
```

## Cómo trabajamos

- **TDD siempre:** primero el test, verlo fallar, código mínimo, refactor.
  Escenarios con los helpers de `test/helpers.ts` (`signUp`, `newTrip`, `joinAs`, `uploadMedia`...). Los códigos de login se leen de `devSentCodes` (`src/lib/email.ts`), que se llena cuando no hay `RESEND_API_KEY`.
- **Si tocás la API:** `npm run openapi` y commiteá `openapi.json`. Hay un test que falla si quedó
  desactualizado. Después la app corre `npm run api:generate`.
- **Ramas:** `develop` es la default. Features en `feature/*` (o `fix/*`, `chore/*`) desde `develop`,
  vuelven por PR. `main` es producción. Reglas: PR + CI (`test`) para ambas; `main` además pide
  1 aprobación (el admin puede saltearla desde el PR). No hay push directo a `develop` ni `main`.
- **Idioma:** todo el código en **inglés**: identificadores, comentarios, descripciones de tests
  (`describe`/`it`), nombres de archivos y carpetas, scripts y textos del OpenAPI (summary/description,
  porque terminan como comentarios en el cliente de la app). En **español** quedan solo los mensajes que
  ve el usuario (los `{ error }` de la API y los de validación), los datos de prueba (nombres de viajes,
  epígrafes), los **commits** y los **PRs**. Tablas, columnas de D1 y keys de R2 no se renombran sin una
  migración explícita.
- **Modelos (para cuidar el usage):** planear con **Opus** (diseño, decisiones, partir el trabajo) y
  ejecutar con **workers en paralelo con Sonnet** (subagentes o sesiones con `model: sonnet`), cada uno
  con una tarea acotada y su brief completo (archivos, qué es "terminado", cómo testear). Opus revisa el
  resultado; no implementa él mismo lo que puede hacer un worker.
- `.npmrc` con `legacy-peer-deps=true` (bug de npm 10 con peers de Vitest 4).

```bash
npm test              # 295 tests
npm run test:watch
npm run typecheck
npm run dev           # http://localhost:8787 — /docs para probar
npm run dev:lan       # para que el iPhone lo vea por Wi-Fi (ver abajo)
npm run seed          # 9 rollos de prueba (en curso, revelado, por empezar...) con usuarios <nombre>@rollo.test (ver abajo); imprime rollos con código y etapa, cuentas y qué probar con cada una, y un link de amistad
npm run seed -- --reset   # borra rollos y usuarios de prueba de D1 local (con amistades, links y descripciones) y los recrea (cambian los códigos)
```

**Seed** (`scripts/seed.ts`, `scripts/seed/{lib,scenarios,people,avatars}.ts`; lo puro de `people.ts` tiene tests en
`test/seed-people.test.ts`). Necesita el server local corriendo (`npm run dev:lan` con `DEV_LOCAL_UPLOADS=1`); con
`SEED_API_URL` y `SEED_PERSIST_TO` corre contra otro server/estado aislado. Al final chequea `GET /friends/{id}` de cada amigo
de Juani y falla si los rollos en común no son los esperados. Cuentas:
- `juani@rollo.test`: en todos los rollos menos "Escapada sin Juani"; **admin** de "Finde en Tandil" (empieza mañana).
- Amigos de Juani: Cami, Tomi, Fede (varios rollos en común; descripción corta, de 150 justos y de 3 renglones), Bruno
  (solo Tandil en común; también está en "Escapada sin Juani", que no tiene que aparecer), Pilar (ningún rollo), Rama (se salió
  de Tandil, `left_at`) y Vicky (Juani la sacó de Tandil, `removed_at`): estos tres sin rollos en común.
- Lu, Nacho, Sofi... comparten rollos con Juani pero no son amigos. Lu tiene un **link de amistad** nuevo en cada corrida (1 h,
  se imprime el código y `rollo://friends/<CODE>`) y el seed la des-amiga de Juani para poder canjearlo otra vez.
- `nuevo@rollo.test`: sin rollos ni amigos (estados vacíos; el seed le borra los amigos en cada corrida). `rocio@rollo.test`: tiene
  nombre pero no `@usuario` (la app la manda a "Completá tu perfil"). Sin foto: Lu, Mateo, Nuevo y Rocío.

**Subidas en local:** con `DEV_LOCAL_UPLOADS=1` en `.dev.vars` (está en `.dev.vars.example`), las URLs
de subida apuntan al propio worker (`PUT /dev/upload/<key>`, firmado con HMAC, fuera del contrato) y
terminan en el R2 local; así `complete` funciona en `wrangler dev`. Apagado, la ruta no existe.
Ojo: por el `routes` de `wrangler.jsonc`, `wrangler dev` reescribe el host del request al dominio de
producción. `dev:lan` lo evita con `--local-upstream <ip>:8787`; con `npm run dev -- --ip 0.0.0.0` las
URLs de subida salen con `rollo-api.juanifraga.com` y el celular no llega.

## Estado (octubre 2026)

Hecho: cuentas por email, perfil y username, amigos, viajes (crear, unirse, detalle, editar, revelar,
sacar miembros, sumar amigos, salirse), media (registrar, confirmar, feed, descargar, borrar),
contrato OpenAPI, CI.

**Producción** (deployado el 22/10/2026), todo en la cuenta de Cloudflare de Juani:

- Worker `rollo-api` en `https://rollo-api.juanifraga.com`. **Se deploya desde `main`** (PR
  `develop` → `main`; el admin saltea la aprobación desde el PR).
- D1 `rollo` (región ENAM, id en `wrangler.jsonc`) y bucket R2 `rollo-media`.
- Secrets del Worker: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (token de R2 con Object
  Read & Write sobre `rollo-media`) y `RESEND_API_KEY` (Sending access a `juanifraga.com`). Se cargan con
  `npx wrangler secret put <NOMBRE>` desde una terminal interactiva y no se pueden volver a leer.
- Mail: dominio `juanifraga.com` verificado en Resend (DKIM en `resend._domainkey`, MX/SPF en `send`,
  DMARC `p=none` en `_dmarc`), DNS en Cloudflare. Plan gratis: 100 mails por día y 3.000 por mes.
- Faltan `REVIEW_EMAIL` y `REVIEW_CODE` (cuenta de App Review); hacen falta antes de mandar a revisión.

Para deployar una versión nueva, con `main` al día:

```bash
npm run db:migrate:remote   # si hay migraciones nuevas
npm run deploy
```

Logs en vivo: `npx wrangler tail rollo-api`.

## Próximos pasos del backend

1. Probar una subida real a R2 en producción (con el primer build de TestFlight).
2. Lo que pida la etapa de cámara y subida de la app (probablemente nada nuevo).
3. **Modo viaje:** tabla `prompts`, registro de push tokens de Expo por miembro, cron que cada noche
   sortea para cada miembro un horario del día siguiente (ventana ~10–21 h en la zona del viaje,
   separados entre sí para que no coincidan) y otro cron que manda el push con un disparador
   ("un detalle que nadie más esté mirando"). Se apaga solo al terminar el viaje. El "momento" es
   foto principal + selfie (selfie ~1080 px).
4. "Volver a entrar como X" si alguien cambia de celular, aprobado por el admin.
5. Paginación del feed si un viaje pasa de unos cientos de fotos.
