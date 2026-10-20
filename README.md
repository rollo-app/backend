# rollo-api

Backend de **Rollo**: Cloudflare Workers + Hono + D1 (SQLite) + R2.

```
src/
  index.ts          app, errores, montaje de rutas, /openapi.json y /docs
  schemas.ts        contrato de la API (zod → validación, tipos y OpenAPI)
  types.ts          tipos de Env y filas de la base
  lib/auth.ts       sesiones (solo se guarda el hash) y middlewares user/member/admin
  lib/r2.ts         URLs prefirmadas para subir directo a R2
  lib/util.ts       fecha local del viaje, revelado, códigos
  lib/openapi.ts    app con validación por contrato y helpers de respuestas
  routes/trips.ts   crear, unirse, info, editar, revelar, sacar miembros
  routes/media.ts   registrar, confirmar subida, feed, descargar, borrar
migrations/
  0001_init.sql     trips, members, media
scripts/
  export-openapi.ts genera openapi.json
openapi.json        contrato versionado (lo consume la app mobile)
test/
  setup.ts          base y bucket vacíos + migraciones antes de cada test
  helpers.ts        api(), createTrip(), join(), uploadMedia()...
  util.test.ts      unitarios: fechas, revelado, tokens, URLs firmadas
  trips.test.ts     integración: viajes, auth, admin, revelado
  media.test.ts     integración: registro, límites, subida, feed, descargas
  openapi.test.ts   contrato: endpoints, auth, modelos y respuestas reales
```

## Tests

```bash
npm test             # corre todo una vez
npm run test:watch   # modo watch, para trabajar en TDD
npm run typecheck    # tipos de src y de test
```

Los tests corren **dentro del runtime de Workers** (`@cloudflare/vitest-plugin`) con D1 y R2
locales reales, no mocks. Cada test arranca con la base vacía y el esquema migrado, así que
son independientes y se pueden correr en cualquier orden.

### Cómo trabajar en TDD

Para cada funcionalidad nueva (por ejemplo, Modo viaje):

1. **Rojo:** escribí el test primero en `test/<feature>.test.ts`, describiendo el comportamiento
   en español ("no deja votar dos veces"). Corré `npm run test:watch` y miralo fallar.
2. **Verde:** escribí el mínimo código en `src/` para que pase.
3. **Refactor:** limpiá con los tests en verde.

Si la funcionalidad cambia la base, la migración nueva (`migrations/0002_...sql`) se aplica sola
en los tests. Usá los helpers de `test/helpers.ts` para armar escenarios en una línea.

> `.npmrc` tiene `legacy-peer-deps=true` por un bug de npm 10 con las dependencias opcionales de Vitest 4.

## Setup (una sola vez)

```bash
npm install
npx wrangler login

# Base de datos: copiá el database_id que te devuelve y pegalo en wrangler.jsonc
npx wrangler d1 create rollo

# Bucket para fotos y videos
npx wrangler r2 bucket create rollo-media
```

**Credenciales S3 de R2** (para firmar URLs de subida): en el dashboard de Cloudflare →
R2 → *Manage API tokens* → *Create API token* con permiso **Object Read & Write**
limitado al bucket `rollo-media`. Te da un *Access Key ID* y un *Secret Access Key*.
El *Account ID* está en la columna derecha del dashboard.

```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

## Desarrollo local

```bash
cp .dev.vars.example .dev.vars   # valores falsos alcanzan para probar
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

En local D1 y R2 se simulan en `.wrangler/`. Las URLs firmadas apuntan a R2 real, así que
para probar subidas de verdad usá credenciales reales en `.dev.vars`, o subí archivos al R2
local con `npx wrangler r2 object put rollo-media/<key> --file foto.jpg --local`.

## Deploy

```bash
npm run db:migrate:remote
npm run deploy                   # queda en https://rollo-api.juanifraga.com
```

## Contrato (OpenAPI)

La API se define con esquemas de zod en `src/schemas.ts` y rutas de `@hono/zod-openapi`.
De ahí salen la validación de requests, los tipos de las respuestas y el contrato:

- `GET /openapi.json`: el contrato OpenAPI 3.1.
- `GET /docs`: documentación interactiva para probar los endpoints.
- `openapi.json` en la raíz: el mismo contrato versionado. La app mobile genera su cliente desde acá.

**Si cambiás la API, corré `npm run openapi` y commiteá el archivo.** Hay un test que falla si el
`openapi.json` versionado no coincide con el código, así que el CI no te deja olvidarlo.

## API

Todas las rutas salvo `/auth/email/*` llevan `Authorization: Bearer <token de sesión>`.
Fechas en epoch milisegundos. Errores: `{ "error": "mensaje" }`.

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| POST | `/auth/email/start` | cualquiera | `{email}` → manda un código de 6 dígitos (204) |
| POST | `/auth/email/verify` | cualquiera | `{email, code}` → `{token, user, isNew}` |
| POST | `/auth/logout` | sesión | Cierra la sesión actual |
| GET / PATCH | `/me` | sesión | Perfil (`{name, username}` para editar; el username es único) |
| GET | `/usernames/{username}` | sesión | `{available, username}` (normalizado); 400 si el formato es inválido |
| GET | `/me/trips` | sesión | Mis rollos |
| POST | `/trips` | sesión | Crea el viaje (requiere nombre en el perfil); devuelve el código |
| POST | `/trips/join` | sesión | `{code}` → 201 si te uniste, 200 si ya eras miembro |
| GET | `/trips/:tripId` | miembro | Viaje, miembros, fotos/videos que te quedan hoy |
| PATCH | `/trips/:tripId` | admin | Nombre, fin, revelado, límites |
| POST | `/trips/:tripId/reveal` | admin | Revela el rollo ya |
| DELETE | `/trips/:tripId/members/:memberId` | admin | Saca a alguien (sus fotos quedan) |
| POST | `/trips/:tripId/media` | miembro | Registra foto/video → 2 URLs para subir |
| POST | `/media/:mediaId/complete` | dueño | Confirma que subió los archivos |
| GET | `/trips/:tripId/feed` | miembro | Antes del revelado: solo metadata. Después: con archivos |
| GET | `/trips/:tripId/media/:mediaId/thumb\|original` | miembro | Descarga (solo revelado) |
| DELETE | `/media/:mediaId` | dueño | Borra una foto propia antes del revelado |

### Flujo de subida desde la app

1. Al disparar, la app genera un **UUID** y guarda foto + metadata en la cola local.
2. Con señal: `POST /trips/:id/media` con `{ id, type, takenAt, lat, lng, accuracyM, caption, durationS, width, height, sizeBytes }`.
3. `PUT` del archivo a `upload.original` y del thumbnail (JPEG ~800px) a `upload.thumb`. Vencen en 15 minutos.
4. `POST /media/:id/complete`. Con `uploaded`, se borra el archivo local.

Si algo falla a mitad de camino, se reintenta desde el paso 2 con el **mismo UUID**: el
server devuelve URLs nuevas sin duplicar ni gastar cupo del día.

### Reglas que aplica el server

- **Revelado:** nadie descarga nada (ni lo propio) hasta `revealAt` o hasta que el admin revele.
- **Límite diario:** por persona, tipo y fecha local del viaje (`timezone`). Cuentan también las pendientes.
- **Videos:** hasta 15 s y 60 MB. Fotos: hasta 25 MB.
- **Hora:** se usa la del celular al sacar la foto; se rechaza si está en el futuro o es de antes del viaje.

## Pendiente

- Volver a entrar con el mismo nombre (aprobado por el admin) si alguien cambia de celular.
- Modo viaje: tabla `prompts`, cron que sortea horarios y push con Expo.
- Paginación del feed si un viaje pasa de unos cientos de fotos.
