# 0003 — Dominio propio: `rolloproject.com`

- **Estado:** aceptada (Juani compró el dominio el 11/11/2026)
- **Fecha:** 11/11/2026
- **Revisar:** cuando casi nadie use builds anteriores a la primera versión que habla con el dominio nuevo (para apagar los subdominios de `juanifraga.com`), o si cambia la marca

Cubre `rollo-app/backend`, `rollo-app/mobile` y `rollo-app/web` (el sitio, que se separó de `mobile` en esta misma mudanza).

## Contexto

Rollo vivía en subdominios del dominio personal de Juani: la API en `rollo-api.juanifraga.com`, el sitio (landing,
`/entrar`, `/friends`, legales) en `rollo.juanifraga.com`, y los mails salían de `rollo@juanifraga.com` (soporte en
`soporte@juanifraga.com`). Para la marca, para los mails (BIMI, reputación propia) y para registrar el remitente en el
relay de "Ocultar mi email" de Apple conviene un dominio de Rollo.

## Alternativas

- `rollo.app`, `rolloapp.com`, `getrollo.com`, `rollo.com.ar`: tomados.
- `rollo.photos` / `rollo.camera`: libres, exactos, pero terminaciones caras y menos conocidas.
- `rollo.cc`: corto, pero `.cc` arrastra mala reputación para mails.
- `somosrollo.com`: `.com`, en español, "somos" encaja con una app de grupo. **Se usó unas horas** (API, mail, sitio)
  y se reemplazó el mismo día.
- **`rolloproject.com`** (elegido): `.com` y la marca pasa a ser **"Rollo Project"**, en la línea de las marcas
  jóvenes con anglicismo (Nude Project, Eme Studios). Comprado en Cloudflare Registrar (DNS en la misma cuenta).

## Decisión

| Qué | Nuevo | Viejo (queda andando) |
|---|---|---|
| Sitio | `rolloproject.com` | `rollo.juanifraga.com` y `somosrollo.com` redirigen |
| API | `api.rolloproject.com` | `rollo-api.juanifraga.com`; `api.somosrollo.com` queda como alias |
| Mails | `no-reply@rolloproject.com` (envía), `support@rolloproject.com` (recibe) | `rollo@` / `soporte@juanifraga.com` |

**Nada se apaga:** los builds instalados tienen fijos la API vieja y el dominio de Universal Links viejo, y los mails y
links de amistad ya mandados apuntan al sitio viejo. Los dominios sirven lo mismo (la API, el mismo Worker; el sitio, el
mismo proyecto de Vercel, con el mismo archivo de Universal Links) por tiempo indefinido.

**El sitio está en Vercel** (repo `rollo-app/web`, deploy por git: `main` → producción, previews por PR), en vez del
Worker `rollo-site` de Cloudflare. El DNS de los dominios sigue en Cloudflare, con los registros del sitio en "DNS only".

## Etapas

1. **Infraestructura en paralelo (sin cambiar a nadie):** el Worker de la API atiende también `api.rolloproject.com`;
   el sitio se publica en Vercel con `rolloproject.com` (canónico); `somosrollo.com` y `rollo.juanifraga.com` redirigen
   (308, con ruta y fragmento: los builds viejos siguen abriendo `/entrar` y `/friends`, aunque pasan por Safari porque
   Apple no sigue redirecciones para el archivo de Universal Links); se borra el Worker `rollo-site`.
2. **Mail:** verificar `rolloproject.com` en Resend (DKIM, SPF, DMARC), Email Routing de Cloudflare para `support@` →
   Gmail (los mails salen de `no-reply@`, que no recibe; el mail del código responde a `support@`). Registrar el
   remitente en el portal de Apple (relay de "Ocultar mi email").
3. **App (próximo build, 1.4.0):** `API_URL`, `SITE_URL` y los links (`/login`, antes `/entrar`, y `/friends`) al dominio nuevo, y
   `associatedDomains` solo con el dominio nuevo (`rollo.juanifraga.com` redirige, así que Apple no puede bajar su archivo
   de Universal Links); la app sigue reconociendo los links viejos de amistad y de mail. Rutas del sitio en inglés
   (`/login`, `/support`, `/privacy`, `/terms`; las viejas en español redirigen). El backend pasa `LOGIN_LINK_URL` y el link de
   amistad al dominio nuevo (los builds viejos igual los abren: esas páginas mandan a `rollo://`).
4. **A mano:** URLs de App Store Connect (soporte, privacidad, marketing), pantalla de consentimiento de Google
   (dominio autorizado, links), `front-admin` (URL de la API) y Web Analytics del sitio nuevo. BIMI después.

## Consecuencias

- Hay que mantener varios dominios. Cuesta poco (mismos Workers, mismo proyecto de Vercel) pero cualquier cosa que
  dependa del host (Universal Links, CSP, analytics) se configura para todos los que sirven el sitio.
- El certificado gratis de Cloudflare cubre `*.rolloproject.com`: un solo nivel de subdominio, como hasta ahora.
