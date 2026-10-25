# Rollo — backend

Contexto para Claude Code. Respondé en español rioplatense (voseo), conciso y con recomendaciones directas.

## Qué es Rollo

App iOS para fotos y videos de viaje en grupo. Cada uno saca fotos durante el viaje y **nadie ve nada
—ni siquiera lo propio— hasta el revelado al final**, como un rollo de fotos. Pensada para un viaje con
amigos al sur de Argentina en **enero de 2027**; también para armar fotolibros después.

Decisiones de producto que el backend tiene que respetar:

- **Cuentas con email.** Se entra con email + código de 6 caracteres (A-Z y 2-9 sin ambiguos, vence a los 5 min; en `verify` se ignoran mayúsculas, espacios y guiones) (`/auth/email/*`, mail por Resend). El mail trae además un **link mágico** del mismo intento, **atado al celular que pidió el código** (tipo PKCE): `POST /auth/email/start` `{ email, linkChallenge? }` y `POST /auth/email/verify-link` `{ email, token, verifier }` (token de 32 bytes base64url, guardado hasheado en `auth_codes.link_hash`; mismo vencimiento, intentos y uso único que el código: usar uno consume los dos; cualquier falla → 400 "El link venció o ya se usó. Pedí otro código."). El link es `LOGIN_LINK_URL` (default `https://rollo.juanifraga.com/entrar`) `#t=<token>&e=<email>`: van en el fragmento para que los scanners de mail no lo vean; nunca se acepta por GET. En tests se lee de `devSentLinks`. Cualquiera de los dos
  devuelve un token de sesión (365 días desde el último uso: se renueva sola, al usarla, como máximo una vez por día). El nombre (y después el avatar) vive en el perfil (`/me`) y es
  el mismo en todos los rollos, sin ser único. El perfil tiene además una **descripción** opcional (`bio`, `PATCH /me`: se guarda con trim, vacía → `null`, hasta 150 caracteres y 3 renglones; `\r\n` cuenta como un salto) que es **pública** (`Friend.bio`, `GET /users/{id}`). El perfil es **privado (`friends`, default) o público** (`profileVisibility`, `PATCH /me`): las destacadas y la lista de amigos completa las ven vos, tus amigos o, si es público, cualquiera con sesión; nombre, @, foto, descripción y cantidad de amigos se ven siempre. `GET /users/{id}` es el perfil de cualquier usuario (`canSee`, `isFriend`, `friendCount`, `mutualCount`: amigos en común, 0 para vos). `GET /users/{id}/friends` → `{ scope: "all" | "mutual", friends }` (solo `id, name, username, avatarUrl`, por nombre): todos si `canSee`, si no solo los amigos en común. También hay un **username único** (`@juanifraga`, minúsculas, `a-z 0-9 . _`, 3–30; `src/lib/username.ts`). Crear un viaje o unirse requiere nombre y username en el perfil; unirse es solo
  el código de 6 caracteres (idempotente; si el admin te sacó, 403). Cuenta de App Review: `REVIEW_EMAIL`/`REVIEW_CODE`.
- **Amigos** (`src/modules/friends/`, `src/lib/friend-code.ts`): la amistad es simétrica y se crea **sin aceptación**
  (`friendships`, par ordenado `user_a < user_b`). `POST /friends/link` genera un código de 8 caracteres (guardado hasheado) que vale
  **1 hora**, es multiuso y se reemplaza al generar otro. `POST /friend-links/claim` (**sin sesión**) devuelve un `claimToken`
  (24 h) para canjear después de registrarse; `POST /friends/redeem` canjea con `code` o `claimToken`. Cualquier falla es el mismo 400
  genérico; 10 fallas por usuario o IP en una hora → 429 (`friend_attempts`). Cualquier miembro suma **a sus amigos** a un rollo
  (`POST /trips/{id}/members`, respuesta por amigo, no si ya se reveló). `members.left_at` (se salió: `DELETE /trips/{id}/members/me`,
  puede volver por código o por amigos, sus fotos quedan) es distinto de `removed_at` (lo sacó el admin: no vuelve por código ni si lo suma un miembro; solo el admin lo puede volver a sumar como amigo, y recupera sus fotos). El admin no puede salirse.
- **Destacadas** (`src/modules/featured/`, `src/lib/zone.ts`): cada uno elige hasta **60 fotos** (no videos) de rollos **revelados**
  donde es miembro activo, suyas o de otros, para su perfil (`PUT/DELETE /me/featured/{mediaId}`, tabla `featured`). El autor puede
  no dejar que otros la destaquen (`PUT/DELETE /media/{id}/feature-block`, `media.feature_blocked_at`): borra las de otros y las nuevas dan
  409; él sí puede. `GET /users/{id}/featured` (permiso del perfil, si no 403 "Este perfil es privado") **nunca** devuelve el rollo, el
  caption ni la coordenada exacta: solo una **zona** (centro de la celda de 0.05°, ~5 km) y el autor si no es el dueño. Los archivos se
  sirven por `/featured/{userId}/{mediaId}/{variant}` con el permiso del perfil, no del rollo. No se ven (ni sus archivos) si la foto se
  borró, se bloqueó o el dueño ya no es miembro activo de ese rollo. El feed revelado trae `featuredByMe` y `featureBlocked`, y todo
  ítem del feed trae `author.userId`.
- **Notificaciones push** (`src/lib/push.ts`, `src/lib/trip-notices.ts`): se mandan con Expo Push Service
  (`POST https://exp.host/--/api/v2/push/send`, lotes de 100, sin access token). `sendPush(env, userIds, kind, message, { actorId })`
  es el único lugar que manda: saca al actor, a quien tenga un bloqueo con él (cualquier sentido) y a quien apagó ese tipo
  (`user_settings`); cada push lleva `data.url` (deep link de la app). Nunca tira error: en las rutas se corre con `deferPush(c, ...)`
  (`waitUntil`) **después** de guardar. Eventos: sumar a un rollo (`addedToTrip`), canjear tu link (`newFriend`), destacar una foto
  ajena (`photoFeatured`), revelado manual (`tripRevealed`, al resto de los miembros activos). El **Cron Trigger** (cada 5 min,
  `scheduled` en `src/index.ts`) manda "Arrancó" y "Se reveló" a los miembros activos y revisa los recibos de Expo (`push_receipts`,
  ~15 min después) para borrar tokens con `DeviceNotRegistered`. Para no avisar dos veces se "reclama" el rollo con
  `started_notified_at` / `revealed_notified_at` en un solo `UPDATE ... WHERE ... IS NULL`; un rollo ya revelado (o terminado)
  cuando arranca se marca sin avisar. En tests, `mockExpo()` (`test/helpers.ts`) reemplaza a Expo (sin él, llamar a Expo falla) y
  `flushPendingPushes()` espera las push diferidas.
  **Tokens:** `PUT /me/push-tokens/{token}` (idempotente; si el token era de otra cuenta pasa a esta: mismo celular, otra
  sesión) y `DELETE` al cerrar sesión; borrar la cuenta los borra todos (tabla `push_tokens`). **Preferencias:**
  `GET/PATCH /me/settings` → `{ notifications: { addedToTrip, newFriend, tripStarted, tripRevealed, photoFeatured, photoLiked } }`
  (tabla `user_settings`, una columna `notify_*` por tipo, 1 por defecto; sin fila = todo prendido; `src/lib/settings.ts`).
  `profileVisibility` sigue en `users`.
- **"Me gusta"** (`src/modules/likes/`, `src/lib/likes.ts`, tabla `likes`): `PUT/DELETE /media/{mediaId}/like`, 204 e
  idempotentes. Solo fotos. Puede dar "me gusta" **quien puede ver la foto**: miembro activo de su rollo ya revelado, o quien puede
  ver (`canSeeProfile`) un perfil donde la foto se ve destacada **ahora** (mismas reglas que `VISIBLE_FROM/WHERE` de
  `featured.ts`: no borrada, no bloqueada por el autor, el dueño sigue en el rollo). Si no, o si hay bloqueo con el autor o la
  denunciaste, 404; un video que sí ves, 400. `DELETE` siempre da 204 (no revela nada) y permite sacar un "me gusta" aunque ya
  no veas la foto. Un solo contador por foto: `likeCount` y `likedByMe` van en el feed revelado y en `FeaturedPhoto`
  (agregados en la misma consulta, sin N+1). Push `photoLiked` al autor ("A Cami le gustó tu foto", abre
  `/photo/<id>?tripId=<trip>`) con **anti-spam por foto**: el primero avisa y abre una ventana de 30 min
  (`media.like_notified_at`); los de adentro se cuentan (`media.likes_since_notified`) y el primero después de la ventana avisa
  sumándolos ("A Cami y 3 más les gustó tu foto"). La decisión es un `UPDATE ... WHERE like_notified_at IS NULL OR <= now - 30 min`
  en un batch con la lectura del contador, así dos "me gusta" a la vez no avisan los dos. Sacar un "me gusta" no avisa ni
  descuenta los callados; si nadie más da "me gusta" después de la ventana, los callados no se avisan.
- **"Tu actividad" → `GET /me/likes?cursor&limit`** (`likes.service.ts`/`likes.repository.ts`): las fotos que te gustaron y **hoy** podés abrir,
  de la más reciente a la más vieja (`likedAt`, desempate por id; cursor opaco, `limit` 1–100, default 60), con `total` (campo extra) para la
  cantidad. Filtra el server, en SQL: miembro activo del rollo revelado (`source: { kind: "trip", tripId }`) o dueño de un perfil que ves
  (`canSeeProfile` en SQL) donde sigue destacada (`{ kind: "featured", userId }`, sin rollo; si valen las dos, gana `trip`). Nunca salen
  denunciadas, de autores bloqueados (en ningún sentido) ni videos; el me gusta queda guardado y la foto vuelve si recuperás el acceso.
  Sin migración (un índice `(user_id, created_at)` queda para cuando haga falta).
- **Rate limiting** (`src/lib/rate-limit.ts`, `src/lib/email-caps.ts`, bindings `ratelimits` en `wrangler.jsonc`): Workers Rate Limiting, todo → 429 `{ error: "Estás yendo muy rápido. Probá de nuevo en un minuto." }`.
  `RL_GLOBAL` 120/60 s para toda request (middleware de la app, antes de las rutas; salta `/openapi.json`, `/docs` y `/dev/upload`), con clave = hash del token Bearer
  (una por sesión) o la IP si no hay token; como el token no se valida ahí, con token también corre `RL_IP` (600/60 s por IP, contra tokens inventados).
  `RL_EXPENSIVE` 20/60 s por usuario (`rateLimit("RL_EXPENSIVE")` después de `requireUser`): registrar/completar media, avatar y su complete, "me gusta" (PUT) y sumar amigos al rollo;
  `RL_FILES` 300/60 s por usuario para descargas (rollo y destacadas). **Fail open:** sin el binding (o si falla) la request pasa y se loguea una vez. Los límites del contador son por ubicación de Cloudflare.
  Topes diarios globales (día UTC, tabla `email_counters`, `reserveEmailSlot`): **80** mails de login (`/auth/email/start` → 429 "Hay muchos pedidos de código ahora. Probá en un rato."), de los cuales
  **40** como máximo para emails sin cuenta (altas nuevas; así el spam de direcciones falsas no deja afuera a los usuarios existentes; la cuenta de App Review no cuenta), y **20** por IP por día (un grupo de amigos se registra junto desde el mismo Wi-Fi) (toda clave por IP usa `ipKey`, `src/lib/ip.ts`: IPv6 se corta al /64, IPv4 y `::ffff:a.b.c.d` quedan como IPv4; vale también para el límite de `auth_codes` y `friend_attempts`); al pasarse de cualquiera de los dos topes de altas nuevas **responde 204 igual que un éxito y no manda nada** (un 429 solo para emails nuevos revelaría si existe la cuenta) y **20** mails de soporte
  (denuncias/bloqueos). La primera vez que cada día se llega a un tope de login, un mail de alerta a soporte (`alertCapReached`, usa un cupo de soporte). Cada usuario puede usar **3** mails de soporte por 24 h (denuncias + bloqueos)
  del tope global; el resto se guarda igual pero sin mail (`reports.unemailed` / `blocks.unemailed` quedan en 1; se limpian al salir el mail). El cron (`sendModerationSummary`) manda **un** mail por día UTC a soporte
  (puede pasarse del tope de soporte) con las denuncias y bloqueos que quedaron sin mail (> 10 min de antigüedad), con los curl de admin, y los marca; solo si hay alguno. Además 50 denuncias y 50 bloqueos por usuario cada 24 h (429).
  El cron borra los `email_counters` de más de 2 días. Resend gratis: 100/día. En tests los bindings reales tienen límites enormes (`vitest.config.ts`); los tests de límite usan un binding falso por request.
- **Revelado:** automático en `revealAt` o manual por el admin. Antes del revelado el feed devuelve
  **solo metadata** (autor, hora, lugar, epígrafe) para el mapa en vivo y el feed de epígrafes. Nunca
  URLs ni archivos, tampoco los propios.
- **Límites de subida:** al registrar el celular declara `sizeBytes` y `thumbSizeBytes` (exactos; tope foto 12 MB, video 30 MB, thumb 2 MB) y las URLs de R2 se firman con ese `Content-Length` (header firmado con `allHeaders` de aws4fetch; en dev el `PUT /dev/upload` chequea el largo del body). `complete` compara los tamaños reales con los declarados (o con los topes): si no coinciden borra ambos archivos, da 400 y el registro queda pendiente. El cron borra los pendientes de más de 7 días con sus archivos (`src/lib/pending-cleanup.ts`). Avatar: `POST /me/avatar` pide `sizeBytes` (firmado, hasta 2 MB), borra el pendiente anterior y el cron barre los huérfanos de `avatars/` con más de 1 h, hasta 1000 objetos por corrida y retomando donde quedó la anterior (`cron_state`, clave `avatar_sweep_after`; al llegar al final arranca de nuevo) (`src/lib/avatar-sweep.ts`).
- **Límite diario por persona**, por tipo, según la fecha local en la zona horaria del viaje
  (default 10 fotos, 3 videos). Las pendientes también cuentan.
- **Tope de almacenamiento** (`src/lib/storage.ts`): R2 gratis llega a 10 GB y no puede cobrarse nada. El uso es el máximo entre
  la estimación de D1 (`size_bytes + thumb_size_bytes` de lo no borrado, pendientes incluidas, + 2 MB por usuario con avatar) y la
  última medición real del bucket (`cron_state`). Al 95% de `STORAGE_LIMIT_BYTES` (default 10 GB decimales) los registros nuevos
  (`POST /trips/{id}/media`, no los reintentos) y `POST /me/avatar` dan 503; leer nunca se frena. El cron mide el bucket entero
  como mucho una vez por hora y manda un mail a soporte al cruzar 70%, 85% y 95% (una vez por umbral; se rearma al bajar de 70%).
  En tests el tope se baja con `api(..., { env: { STORAGE_LIMIT_BYTES } })` o se siembra `storage_measured_bytes` en `cron_state`.
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
src/index.ts          app, montaje de routers, /openapi.json, /docs, manejo de errores, cron (scheduled)
src/modules/<mod>/    módulos en 4 capas (ver "Arquitectura por capas"): admin, auth, avatars, blocks, featured, friends, likes, me, media, reports, trips, users, usernames
src/db/schema.ts       esquema Drizzle de toda la DB (camelCase en TS, columnas snake_case); las migraciones SQL siguen siendo la fuente de verdad y `npm run db:check-schema` falla si se desalinean
src/shared/           db.ts (`orm`, `toStatement`), errors.ts (errores de dominio → status HTTP), after-response.ts (push que el controller difiere)
src/schemas.ts        contrato compartido (zod + OpenAPI); lo de un solo módulo va a <mod>.schemas.ts
src/lib/              auth (sesiones y middlewares), openapi helpers, r2 (presign, servir archivos), util (fechas, revelado), login-code (códigos), friend-code (amistad), profile-access (areFriends, canSeeProfile), zone (zona de ~5 km), settings (preferencias), push (Expo), trip-notices (avisos del cron), likes (anti-spam y texto de "me gusta"), account (borrar cuenta), storage, rate-limit, email...
migrations/           D1 (se aplican solas en los tests)
test/                 vitest dentro de workerd, con D1 y R2 locales reales
openapi.json          contrato versionado — regenerar con `npm run openapi`
```

### Arquitectura por capas

Cada módulo vive en `src/modules/<mod>/` con cuatro capas más sus schemas (sin `repository` o `schemas` si no hay
nada que poner). El modelo es `src/modules/media/`. Un módulo nuevo se crea con la misma forma; un refactor de
estructura no cambia comportamiento ni contrato (`openapi.json` idéntico, tests sin cambios más allá de imports).

| Archivo | Hace | No hace |
|---|---|---|
| `<mod>.router.ts` | `createRoute` (contrato, middlewares, respuestas documentadas), exporta cada ruta y la monta con `router.openapi(route, controller.fn)` | lógica |
| `<mod>.controller.ts` | handlers `RouteHandler<typeof xRoute, AppEnv>`: leen el input validado y el contexto (`user`, `trip`, `member`), llaman al service, mapean a la respuesta (presenters) y eligen el status | SQL, reglas de negocio |
| `<mod>.service.ts` | toda la lógica de negocio: permisos finos, validaciones de estado, orquestar repos, decidir los `batch`, disparar push | importar `hono`, `HTTPException`, `Context` |
| `<mod>.repository.ts` | todo el SQL. Primer argumento `db: D1Database` | decidir nada |
| `<mod>.schemas.ts` | schemas zod que usa solo ese módulo | — |

Reglas:
- **Escrituras como sentencias:** en el repository las lecturas ejecutan y devuelven filas tipadas; las escrituras
  devuelven un `D1PreparedStatement` sin ejecutar. El service hace `.run()` o las junta en `db.batch([...])`. Es
  porque D1 no tiene transacciones interactivas: `batch` es la única forma de que varias escrituras sean atómicas, y
  qué va junto es una decisión de negocio.
- **Errores de dominio:** el service tira `badRequest` / `forbidden` / `notFound` / `conflict` / `rateLimited` /
  `unavailable` (`src/shared/errors.ts`) con el mensaje en español para el usuario; `onError` los traduce a
  400/403/404/409/429/503. Así un service se puede llamar desde el cron sin HTTP de por medio. Un status sin kind
  (500 al no poder generar un código de rollo, 502 si Resend falla) lo tira el controller como `HTTPException`
  a partir de lo que devuelve el service.
- **Push:** `deferPush` necesita el contexto de Hono (`waitUntil`). El service arma el push completo (destinatarios,
  texto, url, actor) y lo devuelve como `notify: AfterResponse` (`src/shared/after-response.ts`: una función que
  todavía no arrancó, o `null`); el controller solo hace `if (notify) deferPush(c, notify())`. Los mails de
  moderación se esperan en el service, no se difieren.
- **Entre módulos:** un service puede llamar a services de otros módulos (ej. `admin` usa `deleteTripMedia` de
  media, `me` usa el chequeo de username de `usernames`) y pedir *sentencias de escritura* a repos de otros módulos
  solo para armar un `batch` atómico (ej. `media` borra destacadas con `featured.repository`). Las reglas de
  visibilidad de una foto destacada (`VISIBLE_FROM` / `VISIBLE_WHERE`) viven en `featured.repository` y las importan
  los repos de `likes` y `reports`, para que la regla esté en un solo lugar. Nadie importa el router ni el
  controller de otro módulo.
- **Middlewares** (sesión, membresía, admin, rate limit) van en el `middleware` de cada `createRoute`; su código
  vive en `src/lib/auth.ts` y `src/lib/rate-limit.ts`. Las rutas `/admin/*` quedan fuera del contrato (Hono plano).
- **`src/lib/`** queda para lo transversal (sesiones, R2, mail, push, storage, rate limit, helpers puros). Parte
  todavía tiene SQL (`account`, `profile-access`, `settings`, `trip-notices`...): pasarlo a módulos es un paso
  pendiente.
- **PRs:** un refactor de estructura que toca varios módulos puede ir en un solo PR, con un commit por módulo o
  grupo, para no encadenar conflictos en `src/index.ts` y `src/schemas.ts`.
- **Sin interfaces por capa:** services y repos son módulos de funciones tipadas; el contrato es la firma exportada.
  Interfaces explícitas solo donde hay más de una implementación (storage, mail, push).
- **Comentarios explicativos** (por qué una regla es así) van junto a la lógica, o sea, en el service.

## Cómo trabajamos

- **Decisiones grandes** (stack, proveedores, arquitectura) se discuten con Juani, con alternativas, antes de
  implementarlas, y quedan en `docs/decisiones/NNNN-tema.md` (contexto, criterios, alternativas, decisión,
  consecuencias, cuándo revisarla). La del stack: [`docs/decisiones/0001-stack.md`](docs/decisiones/0001-stack.md).
- **TDD siempre:** primero el test, verlo fallar, código mínimo, refactor.
  Escenarios con los helpers de `test/helpers.ts` (`signUp`, `newTrip`, `joinAs`, `uploadMedia`...). Los códigos de login se leen de `devSentCodes` (y los links mágicos de `devSentLinks`) (`src/lib/email.ts`), que se llena cuando no hay `RESEND_API_KEY`.
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
npm test              # 620 tests
npm run test:watch
npm run typecheck
npm run dev           # http://localhost:8787 — /docs para probar
npm run dev:lan       # para que el iPhone lo vea por Wi-Fi (ver abajo)
npm run dev -- --test-scheduled   # + correr el cron a mano: curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
npm run seed          # 9 rollos de prueba (en curso, revelado, por empezar...) con usuarios <nombre>@rollo.test (ver abajo); imprime rollos con código y etapa, cuentas y qué probar con cada una, y un link de amistad
npm run seed -- --reset   # borra rollos y usuarios de prueba de D1 local (con amistades, links y descripciones) y los recrea (cambian los códigos)
npm run email:preview   # escribe login-email-preview.html (git-ignored) con el mail del código, para abrirlo en el navegador
```

**Seed** (`scripts/seed.ts`, `scripts/seed/{lib,scenarios,people,avatars,featured,likes}.ts`; lo puro de `people.ts` tiene tests en
`test/seed-people.test.ts`). Necesita el server local corriendo (`npm run dev:lan` con `DEV_LOCAL_UPLOADS=1`); con
`SEED_API_URL` y `SEED_PERSIST_TO` corre contra otro server/estado aislado. Al final chequea `GET /friends/{id}` de cada amigo
de Juani y falla si los rollos en común no son los esperados, y chequea las destacadas (las de Juani como amiga y como desconocido, las de
Tomi como desconocido). Cuentas:
- `juani@rollo.test`: en todos los rollos menos "Escapada sin Juani"; **admin** de "Finde en Tandil" (empieza mañana). Perfil privado
  con **5 destacadas** de Bariloche (3 suyas, 2 de Tomi y Fede).
- Insignias: Juani `founder`; Cami y Lu `first_edition`; el resto sin insignia (`SEED_BADGES` en `people.ts`).
- Destacadas: **Tomi** tiene perfil **público** (3 destacadas, se ven sin ser amigo); **Cami** no deja destacar su primera foto de Bariloche.
  Se rehacen en cada corrida (`planFeatured` en `people.ts`).
- "Me gusta" en Bariloche (`planLikes` en `people.ts`, se rehacen y chequean en cada corrida): la primera foto de Juani tiene 5
  (todos los demás miembros), la primera de Tomi 2 (Juani y Cami) y la primera de Fede 1 (Juani). Los usuarios del seed no tienen
  push tokens, así que no se manda nada a Expo.
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

Hecho: cuentas por email (código y link mágico), perfil y username, amigos, viajes (crear, unirse, detalle,
editar, revelar, sacar miembros, sumar amigos, salirse), media (registrar, confirmar, feed, descargar, borrar),
destacadas, "me gusta", notificaciones push con cron, moderación, contrato OpenAPI, CI.

**Producción** (deployado el 22/10/2026), todo en la cuenta de Cloudflare de Juani:

- Worker `rollo-api` en `https://rollo-api.juanifraga.com`. **Se deploya desde `main`** (PR
  `develop` → `main`; el admin saltea la aprobación desde el PR).
- D1 `rollo` (región ENAM, id en `wrangler.jsonc`) y bucket R2 `rollo-media`.
- Secrets del Worker: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (token de R2 con Object
  Read & Write sobre `rollo-media`) y `RESEND_API_KEY` (Sending access a `juanifraga.com`). Se cargan con
  `npx wrangler secret put <NOMBRE>` desde una terminal interactiva y no se pueden volver a leer.
- Mail: dominio `juanifraga.com` verificado en Resend (DKIM en `resend._domainkey`, MX/SPF en `send`,
  DMARC `p=none` en `_dmarc`), DNS en Cloudflare. Plan gratis: 100 mails por día y 3.000 por mes.
- Secrets de moderación: `ADMIN_TOKEN` (habilita las rutas `/admin/*`; sin él dan 404) y opcional `REPORTS_EMAIL` (mail de las denuncias, default `soporte@juanifraga.com`). Las rutas `/admin/*` (`src/modules/admin/`) están **fuera del contrato** (no van a `openapi.json`). Cómo actuar sobre una denuncia: [`docs/moderacion.md`](docs/moderacion.md).
- Faltan `REVIEW_EMAIL` y `REVIEW_CODE` (cuenta de App Review); hacen falta antes de mandar a revisión.

Para deployar una versión nueva, con `main` al día:

```bash
npm run db:migrate:remote   # si hay migraciones nuevas
npm run deploy
```

**Link mágico atado al celular:** la app genera un `verifier` al azar (se queda en el celular) y manda en `start` el `linkChallenge` =
base64url(SHA-256(verifier)) (43 caracteres, se valida el formato; se guarda en `auth_codes.link_challenge`). `verify-link` solo entra si
SHA-256(verifier) coincide con el challenge **y** el token coincide (comparación en tiempo constante, después de tomar el intento: un
verifier mal o ausente cuenta como intento fallido). Así un link del atacante abierto en el celular de otro no lo mete en la cuenta del
atacante (login CSRF) y otra app que registre `rollo://` y lo intercepte no puede usarlo. Sin `linkChallenge` (builds viejas) no se genera
link: el mail trae solo el código y `verify-link` siempre falla. `/auth/email/verify` (el código) no cambia.

**Link mágico, notificaciones y "me gusta"** están en producción desde el 22/10/2026 (migraciones `0012`–`0014` aplicadas).
`LOGIN_LINK_URL` no está seteada (usa el default `https://rollo.juanifraga.com/entrar`). El deploy registra el Cron Trigger
(`*/5 * * * *`, `triggers.crons` en `wrangler.jsonc`); se ve en el dashboard del Worker → Settings → Triggers. Sin access token
de Expo: si se activa "enhanced security" en expo.dev hay que sumarlo como secret.

**Insignias de perfil:** columna `users.badge` (migración `0015_user_badges.sql`, aplicar con `npm run db:migrate:remote` **antes** de `npm run deploy`). Se asignan **solo a mano con SQL**, no hay endpoint (`PATCH /me` la ignora): `UPDATE users SET badge='founder' WHERE email='...'`. Valores: `founder` ("Founder") y `first_edition` ("First Edition"); `NULL` = sin insignia. Salen como `badge` en `GET /me` y en `user` de `GET /users/{userId}` (pública, como el nombre); un valor desconocido en la DB sale como `null`.

Logs en vivo: `npx wrangler tail rollo-api`.

## Próximos pasos del backend

1. Probar una subida real a R2 en producción (con el primer build de TestFlight).
2. Lo que pida la etapa de cámara y subida de la app (probablemente nada nuevo).
3. **Modo viaje:** tabla `prompts` (los push tokens y el cron ya existen), un cron que cada noche
   sortea para cada miembro un horario del día siguiente (ventana ~10–21 h en la zona del viaje,
   separados entre sí para que no coincidan) y otro cron que manda el push con un disparador
   ("un detalle que nadie más esté mirando"). Se apaga solo al terminar el viaje. El "momento" es
   foto principal + selfie (selfie ~1080 px).
4. "Volver a entrar como X" si alguien cambia de celular, aprobado por el admin.
5. Paginación del feed si un viaje pasa de unos cientos de fotos.
