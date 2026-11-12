import { escapeHtml } from "../../lib/login-email";

/** The tiny self-contained pages the waitlist email links open in the browser (Spanish, light and dark, no external assets). */
export function renderPage(title: string, message: string, form?: { action: string; token: string; button: string }): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box;
         background:#F2F2F7; color:#000; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width:420px; background:#fff; border-radius:22px; padding:32px 28px; text-align:center; }
  form { margin:24px 0 0; } button { width:100%; padding:14px 20px; border:0; border-radius:14px; background:#3155F5; color:#fff; font-size:17px; font-weight:600; cursor:pointer; }
  h1 { margin:0 0 8px; font-size:22px; } p { margin:0; font-size:17px; line-height:24px; color:#6C6C70; }
  @media (prefers-color-scheme: dark) { body { background:#000; color:#fff; } main { background:#1C1C1E; } p { color:#98989F; } }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p>${form ? `<form method="post" action="${form.action}"><input type="hidden" name="token" value="${escapeHtml(form.token)}"><button type="submit">${form.button}</button></form>` : ""}</main></body>
</html>`;
}

export const CONFIRMED_PAGE = renderPage("Rollo", "¡Listo! Te vamos a avisar cuando Rollo abra para todos.");
export const UNSUBSCRIBED_PAGE = renderPage("Rollo", "Te diste de baja de la lista.");
export const INVALID_LINK_PAGE = renderPage("Rollo", "El link no es válido.");

/** What a mail scanner or a person opening the link sees: nothing happens until the button POSTs the token. */
export const confirmPage = (token: string) =>
  renderPage("Rollo", "Confirmá tu email para quedar en la lista de espera.", { action: "/waitlist/confirm", token, button: "Confirmar" });
export const unsubscribePage = (token: string) =>
  renderPage("Rollo", "¿Querés darte de baja de la lista de espera?", { action: "/waitlist/unsubscribe", token, button: "Darme de baja" });
