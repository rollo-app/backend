# Moderación: qué hacer cuando llega una denuncia

Cuando alguien denuncia una foto o una persona, te llega un mail a `REPORTS_EMAIL` (por defecto `soporte@juanifraga.com`)
con el motivo, quién denunció, a quién, la foto (link vigente 7 días) y los comandos para actuar. También te llega un mail cuando alguien bloquea a otra persona (Apple lo pide).
Cada persona dispara como máximo 10 mails por día (denuncias + bloqueos): lo que pase de ahí se guarda igual y se ve en `GET /admin/reports`, pero sin mail.
**Apple pide actuar en menos de 24 horas**: mirá la foto y, si corresponde, sacala o borrá la cuenta.

## Preparación (una sola vez)

1. Generá un token: `openssl rand -hex 32`
2. Cargalo como secret del Worker (desde una terminal interactiva, pega el valor cuando te lo pida):
   `npx wrangler secret put ADMIN_TOKEN`
3. Guardalo también en tu terminal, para que los `curl` del mail funcionen tal cual:
   `export ROLLO_ADMIN_TOKEN=<el token>`

Sin `ADMIN_TOKEN`, las rutas `/admin/*` no existen (dan 404), igual que con un token equivocado.
Para cambiar de mail de denuncias: `npx wrangler secret put REPORTS_EMAIL`.

## Comandos

Todos contra `https://rollo-api.juanifraga.com`.

Sacar una foto para todos (borra los archivos; responde 204, o 404 si ya no existe):

```bash
curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" https://rollo-api.juanifraga.com/admin/media/<mediaId>
```

Borrar la cuenta de una persona, igual que "Borrar cuenta" en la app (sus fotos, amistades, denuncias y bloqueos se van con ella):

```bash
curl -X DELETE -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" https://rollo-api.juanifraga.com/admin/users/<userId>
```

Ver las últimas denuncias, por si se perdió un mail (hasta 200, las más nuevas primero):

```bash
curl -H "Authorization: Bearer $ROLLO_ADMIN_TOKEN" "https://rollo-api.juanifraga.com/admin/reports?limit=50"
```

Los ids están en el mail y en esta lista. Borrar una cuenta borra también las denuncias sobre ella; el mail queda en tu Gmail.
