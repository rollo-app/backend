# Rollo — backend

Contexto para Claude Code. Respondé en español rioplatense (voseo), conciso y con recomendaciones directas.

## Qué es Rollo

App iOS para fotos y videos de viaje en grupo. Cada uno saca fotos durante el viaje y **nadie ve nada
—ni siquiera lo propio— hasta el revelado al final**, como un rollo de fotos. Pensada para un viaje con
amigos al sur de Argentina en **enero de 2027**; también para armar fotolibros después.

Decisiones de producto que el backend tiene que respetar:

- **Sin cuentas.** Crear un viaje devuelve un token de admin; unirse es código de 6 caracteres + nombre
  (único por viaje, sin distinguir mayúsculas) y devuelve un token de miembro.
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
- **Auth:** `Authorization: Bearer <token>`; en D1 solo se guarda el SHA-256 del token.

```
src/index.ts          app, /openapi.json, /docs, manejo de errores
src/schemas.ts        contrato (zod + OpenAPI)
src/lib/              auth, openapi helpers, r2 (presign), util (fechas, revelado, códigos)
src/routes/           trips.ts, media.ts
migrations/           D1 (se aplican solas en los tests)
test/                 vitest dentro de workerd, con D1 y R2 locales reales
openapi.json          contrato versionado — regenerar con `npm run openapi`
```

## Cómo trabajamos

- **TDD siempre:** primero el test (descripciones en español), verlo fallar, código mínimo, refactor.
  Escenarios con los helpers de `test/helpers.ts` (`createTrip`, `join`, `uploadMedia`...).
- **Si tocás la API:** `npm run openapi` y commiteá `openapi.json`. Hay un test que falla si quedó
  desactualizado. Después la app corre `npm run api:generate`.
- **Ramas:** `develop` es la default. Features en `feature/*` (o `fix/*`, `chore/*`) desde `develop`,
  vuelven por PR. `main` es producción. Reglas: PR + CI (`test`) para ambas; `main` además pide
  1 aprobación (el admin puede saltearla desde el PR). No hay push directo a `develop` ni `main`.
- Mensajes de commit y PR en español.
- **Modelos (para cuidar el usage):** planear con **Opus** (diseño, decisiones, partir el trabajo) y
  ejecutar con **workers en paralelo con Sonnet** (subagentes o sesiones con `model: sonnet`), cada uno
  con una tarea acotada y su brief completo (archivos, qué es "terminado", cómo testear). Opus revisa el
  resultado; no implementa él mismo lo que puede hacer un worker.
- `.npmrc` con `legacy-peer-deps=true` (bug de npm 10 con peers de Vitest 4).

```bash
npm test              # 91 tests
npm run test:watch
npm run typecheck
npm run dev           # http://localhost:8787 — /docs para probar
npm run dev:lan       # para que el iPhone lo vea por Wi-Fi (ver abajo)
npm run seed          # viaje "Sur (prueba)" con ~100 fotos reales; imprime el código para sumarte
```

**Subidas en local:** con `DEV_LOCAL_UPLOADS=1` en `.dev.vars` (está en `.dev.vars.example`), las URLs
de subida apuntan al propio worker (`PUT /dev/upload/<key>`, firmado con HMAC, fuera del contrato) y
terminan en el R2 local; así `complete` funciona en `wrangler dev`. Apagado, la ruta no existe.
Ojo: por el `routes` de `wrangler.jsonc`, `wrangler dev` reescribe el host del request al dominio de
producción. `dev:lan` lo evita con `--local-upstream <ip>:8787`; con `npm run dev -- --ip 0.0.0.0` las
URLs de subida salen con `rollo-api.juanifraga.com` y el celular no llega.

## Estado (octubre 2026)

Hecho: viajes (crear, unirse, detalle, editar, revelar, sacar miembros), media (registrar, confirmar,
feed, descargar, borrar), contrato OpenAPI, CI.

**Todavía no está deployado.** Pasos (la cuenta de Cloudflare es de Juani; `wrangler login` lo hace él):

1. `npx wrangler login`
2. `npx wrangler d1 create rollo` → pegar el `database_id` en `wrangler.jsonc`
3. Activar R2 en el dashboard (pide tarjeta; 10 GB gratis) → `npx wrangler r2 bucket create rollo-media`
4. R2 → Manage API tokens → token Object Read & Write para `rollo-media`
5. `npx wrangler secret put R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
6. `npm run db:migrate:remote && npm run deploy`

## Próximos pasos del backend

1. Deploy (arriba).
2. Lo que pida la etapa de cámara y subida de la app (probablemente nada nuevo).
3. **Modo viaje:** tabla `prompts`, registro de push tokens de Expo por miembro, cron que cada noche
   sortea para cada miembro un horario del día siguiente (ventana ~10–21 h en la zona del viaje,
   separados entre sí para que no coincidan) y otro cron que manda el push con un disparador
   ("un detalle que nadie más esté mirando"). Se apaga solo al terminar el viaje. El "momento" es
   foto principal + selfie (selfie ~1080 px).
4. "Volver a entrar como X" si alguien cambia de celular, aprobado por el admin.
5. Paginación del feed si un viaje pasa de unos cientos de fotos.
