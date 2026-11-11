# 0003 — Dominio propio: `somosrollo.com`

- **Estado:** aceptada (Juani compró el dominio el 11/11/2026)
- **Fecha:** 11/11/2026
- **Revisar:** cuando casi nadie use builds anteriores a la primera versión que habla con el dominio nuevo (para apagar los subdominios de `juanifraga.com`), o si cambia la marca

Cubre `rollo-app/backend`, `rollo-app/mobile` y `rollo-app/web` (el sitio, que se separó de `mobile` en esta misma mudanza).

## Contexto

Rollo vive en subdominios del dominio personal de Juani: la API en `rollo-api.juanifraga.com`, el sitio (landing,
`/entrar`, `/friends`, legales) en `rollo.juanifraga.com`, y los mails salen de `rollo@juanifraga.com` (soporte en
`soporte@juanifraga.com`). Para la marca, para los mails (BIMI, reputación propia) y para registrar el remitente en el
relay de "Ocultar mi email" de Apple conviene un dominio de Rollo.

## Alternativas

- `rollo.app`, `rolloapp.com`, `getrollo.com`, `rollo.com.ar`: tomados.
- `rollo.photos` / `rollo.camera`: libres, exactos, pero terminaciones caras y menos conocidas.
- `rollo.cc`: corto, pero `.cc` arrastra mala reputación para mails.
- **`somosrollo.com`** (elegido): `.com` (la que mejor reputación tiene para mails y la que más confianza da), barato,
  se dice fácil y "somos" encaja con una app de grupo. Comprado en Cloudflare Registrar (DNS ya en la misma cuenta).

## Decisión

| Qué | Nuevo | Viejo (queda andando) |
|---|---|---|
| Sitio | `somosrollo.com` | `rollo.juanifraga.com` |
| API | `api.somosrollo.com` | `rollo-api.juanifraga.com` |
| Mails | `rollo@somosrollo.com`, `soporte@somosrollo.com` | `rollo@` / `soporte@juanifraga.com` |

**Nada se apaga:** los builds instalados tienen fijos la API vieja y el dominio de Universal Links viejo, y los mails y
links de amistad ya mandados apuntan al sitio viejo. Los dos dominios sirven lo mismo (la API, el mismo Worker; el sitio, el
mismo proyecto de Vercel, con el mismo archivo de Universal Links) por tiempo indefinido.

**El sitio pasa a Vercel** (repo `rollo-app/web`, deploy por git: `main` → producción, previews por PR), en vez del Worker
`rollo-site` de Cloudflare. El DNS de los dos dominios sigue en Cloudflare, con los registros del sitio en "DNS only".

## Etapas

1. **Infraestructura en paralelo (sin cambiar a nadie):** el Worker de la API atiende también `api.somosrollo.com`; el sitio
   se publica en Vercel con `somosrollo.com` (canónico) y `rollo.juanifraga.com`, y después se apaga el Worker `rollo-site`.
2. **Mail:** verificar `somosrollo.com` en Resend (DKIM, SPF, DMARC), Email Routing de Cloudflare para `soporte@`
   y `rollo@` → Gmail, y recién ahí `EMAIL_FROM` y los textos de soporte pasan al dominio nuevo. Registrar el
   remitente en el portal de Apple (relay de "Ocultar mi email").
3. **App (próximo build, 1.4.0):** `API_URL`, `SITE_URL` y los links (`/entrar`, `/friends`) al dominio nuevo, y
   `associatedDomains` con **los dos** dominios. El backend pasa `LOGIN_LINK_URL` y el link de amistad al dominio
   nuevo (los builds viejos igual los abren: esas páginas mandan a `rollo://`).
4. **A mano:** URLs de App Store Connect (soporte, privacidad, marketing), pantalla de consentimiento de Google
   (dominio autorizado, links), `front-admin` (URL de la API) y Web Analytics del sitio nuevo. BIMI después.

## Consecuencias

- Hay que mantener los dos dominios. Cuesta poco (mismos Workers) pero cualquier cosa que dependa del host
  (Universal Links, CSP, analytics) se configura para los dos.
- El certificado gratis de Cloudflare cubre `*.somosrollo.com`: un solo nivel de subdominio, como hasta ahora.
