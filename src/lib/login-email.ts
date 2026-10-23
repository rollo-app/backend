export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Renders the login email (subject, plain text and HTML). `url` is the magic link, or null for old app builds
 * (then there is no button, only the code). The code stays unsplit on purpose: a long-press selects it whole.
 */
export function renderLoginEmail({ code, url }: { code: string; url: string | null }): { subject: string; text: string; html: string } {
  const subject = `Tu código de Rollo: ${code}`;
  const text =
    `Tu código de Rollo es ${code}. Vence en 5 minutos.\n\n` +
    (url ? `O tocá este link desde tu iPhone: ${url}\n\n` : "") +
    `Si no lo pediste, ignorá este mensaje.`;

  const button = url
    ? `
          <p class="muted" style="margin:28px 0 12px;font-size:15px;line-height:21px;color:#6C6C70;">¿Lo estás leyendo en el iPhone donde pediste el código? Entrá directo:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <a class="btn" href="${escapeHtml(url)}" style="display:block;padding:14px 20px;border-radius:14px;background:#3155F5;color:#FFFFFF;font-size:17px;font-weight:600;text-decoration:none;text-align:center;">Abrir Rollo</a>
          </td></tr></table>`
    : "";

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Tu código de Rollo</title>
<style>
  @media (prefers-color-scheme: dark) {
    .bg { background:#000000 !important; }
    .card { background:#1C1C1E !important; }
    .label { color:#FFFFFF !important; }
    .muted { color:#98989F !important; }
    .code { background:#2C2C2E !important; color:#FFFFFF !important; }
    .btn { background:#5C7CFF !important; }
    .sep { border-color:#38383A !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#F2F2F7;">
  <!-- Preheader: the line the inbox shows next to the subject -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Vence en 5 minutos. Si no lo pediste, ignorá este mensaje.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:#F2F2F7;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="padding:0 8px 16px;">
          <span class="label" style="font-size:22px;font-weight:700;color:#000000;letter-spacing:-0.3px;">Rollo</span>
        </td></tr>
        <tr><td class="card" style="background:#FFFFFF;border-radius:22px;padding:32px 28px;">
          <p class="label" style="margin:0 0 8px;font-size:22px;font-weight:700;color:#000000;">Tu código para entrar</p>
          <p class="muted" style="margin:0 0 24px;font-size:15px;line-height:21px;color:#6C6C70;">Escribilo en la app. Vence en 5 minutos.</p>
          <div class="code label" style="background:#F2F2F7;border-radius:14px;padding:18px 0;text-align:center;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#000000;-webkit-user-select:all;user-select:all;">${escapeHtml(code)}</div>
          <p class="muted" style="margin:8px 0 0;font-size:13px;text-align:center;color:#8E8E93;">Mantené apretado para copiarlo</p>${button}
        </td></tr>
        <tr><td class="muted" style="padding:20px 8px 0;font-size:13px;line-height:18px;color:#8E8E93;">
          Si no pediste este código, ignorá este mensaje: nadie puede entrar sin él. Nunca te lo vamos a pedir por otro lado.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;
  return { subject, text, html };
}
