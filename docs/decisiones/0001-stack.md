# 0001 — Stack del backend: Cloudflare Workers + D1 + R2

- **Estado:** aceptada (registrada después del hecho)
- **Fecha:** 24/10/2026
- **Revisar:** después del viaje de enero de 2027, o antes si se cumple alguno de los disparadores del final

## Contexto

El backend arrancó el 18/10/2026 (primer commit: "Backend inicial de Rollo: Worker, D1, R2 y tests") sobre
Cloudflare Workers + Hono + D1 + R2. Esa elección **no se evaluó con el dueño del proyecto ni se documentó**: este
registro la evalúa después del hecho, compara alternativas y deja asentado por qué se sigue (y hasta cuándo).

Qué tiene que resolver el backend de Rollo (ver `CLAUDE.md`, "Qué es Rollo"):

- Fotos a resolución completa (~4 MB) y videos de hasta 15 s (hasta 30 MB) que suben desde el celular, y un
  **revelado** donde todos los miembros bajan todo a la vez.
- Uso chico y estacional: un grupo de amigos, un viaje (enero de 2027), algún rollo más. Sin ingresos.
- Lo mantiene una sola persona, full stack, con experiencia en **Go + GORM + Postgres**.
- Usuarios en Argentina.

## Criterios (en orden de peso)

1. **Costo del tráfico de salida.** El revelado baja GBs por rollo; en la mayoría de los proveedores lo que más se
   paga es la salida de datos.
2. **Costo casi cero con poco uso.**
3. **Mantenimiento mínimo:** sin servidores que parchear, reiniciar ni escalar a mano.
4. **Que lo pueda mantener el dueño** (afinidad con lo que ya sabe).
5. **Latencia razonable desde Argentina.**
6. **Poder cambiar de proveedor** sin reescribir todo.

## Alternativas evaluadas

| | **A. Cloudflare** (actual) | **B. Go + Postgres** en Fly.io / Railway / Render, archivos en R2 o S3 | **C. Supabase** (Postgres + Auth + Storage) | **D. Firebase** |
|---|---|---|---|---|
| Salida de fotos | Gratis (R2 no cobra salida) | Gratis con R2; con S3 se paga | Se paga pasado el plan | Se paga |
| Costo con poco uso | US$0 (gratis) o ~US$5/mes (Workers Paid) | ~US$5–20/mes (servidor + DB) | US$0 con límites; ~US$25/mes el plan pago | US$0 con límites |
| Mantenimiento | Ninguno | Bajo (deploys, versión de Go; DB gestionada) | Ninguno | Ninguno |
| Afinidad con el dueño | Baja (TypeScript, runtime propio) | **Alta** (Gin/Echo + GORM + Postgres) | Media | Baja (NoSQL) |
| Base de datos | SQLite (D1): sin transacciones interactivas, un solo escritor | Postgres completo | Postgres completo | Firestore (NoSQL) |
| Atadura al proveedor | Media-alta (D1, runtime de Workers) | Baja | Media | Alta |
| Escala | Automática | Manual pero simple (instancias) | Automática hasta cierto punto | Automática |

Precios aproximados a octubre de 2026; verificarlos en cada proveedor antes de decidir en base a ellos.

## Decisión

**Seguir con Cloudflare (A) al menos hasta después del viaje de enero de 2027.**

- Gana en los tres criterios que más pesan para esta app: salida gratis de R2, costo cero y mantenimiento cero.
- La alternativa más fuerte es **B (Go + Postgres + R2)**: código que el dueño domina, Postgres completo y menos
  atadura, a cambio de ~US$5–20/mes y algo de mantenimiento. Las fotos podrían seguir en R2, así que no se pierde
  la ventaja principal.
- **Cambiar ahora no conviene:** el backend tiene ~4.000 líneas y 620 tests, la app está por salir a TestFlight y el
  viaje es en ~2,5 meses. Reescribirlo pone en riesgo llegar.

## Consecuencias y cómo se mitigan

Lo que se acepta con esta decisión, y qué se está haciendo para que no ate el proyecto:

| Costo | Mitigación |
|---|---|
| D1 es SQLite: sin transacciones interactivas, un escritor | Escrituras atómicas con `db.batch` (convención del repository). Si alguna vez no alcanza: partir la base o pasar a Postgres con Hyperdrive |
| D1 está en la región ENAM: cada query viaja a EE.UU. | Smart Placement (correr el Worker cerca de la base) |
| SQL a mano atado a D1 | **Drizzle ORM** en los repositories: pasar a Postgres es cambiar el dialecto, no reescribir queries |
| Lógica atada a Hono / al runtime de Workers | **Arquitectura por capas** (`CLAUDE.md`): los services no conocen Hono |
| R2, Resend y Expo usados directo | **Interfaces de servicios externos** con la implementación elegida en la inyección de dependencias: pasar a S3 u otro proveedor de mail es una implementación nueva |
| Límites del plan gratis (requests y CPU de Workers, filas de D1, 100 mails/día de Resend, 10 GB de R2) | Pasar a Workers Paid antes del viaje; tope de almacenamiento al 95% con alertas (ya existe) |
| Lenguaje y runtime que el dueño no domina | El contrato OpenAPI y los tests de comportamiento sirven de especificación si se reescribe en Go |

## Cuándo revisar esta decisión

- Después del viaje de enero de 2027, con datos reales de uso, costo y latencia.
- Si D1 se queda corto (escrituras concurrentes, tamaño, o hace falta una transacción que `batch` no resuelve).
- Si el costo mensual de Cloudflare pasa los ~US$20 (el rango donde B empieza a ser comparable).
- Si se suma gente al proyecto y la afinidad con el stack pesa más.

Si se migra, la opción a evaluar primero es **B (Go + Postgres) dejando los archivos en R2**.
