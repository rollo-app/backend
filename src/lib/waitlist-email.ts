import { escapeHtml } from "./login-email";

/** The waitlist confirmation email (subject, plain text and a minimal HTML). Spanish, like the login email. */
export function renderWaitlistEmail({ confirmUrl, unsubscribeUrl }: { confirmUrl: string; unsubscribeUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Confirmá tu lugar en la lista de Rollo";
  const text =
    `Pediste que te avisemos cuando Rollo abra para todos. Confirmá tu email con este link:\n\n${confirmUrl}\n\n` +
    `Si no fuiste vos, ignorá este mensaje: sin confirmar no te escribimos más.\n\n` +
    `Si ya no querés estar en la lista: ${unsubscribeUrl}`;
  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:32px 16px;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#000000;">
  <div style="max-width:440px;margin:0 auto;background:#FFFFFF;border-radius:22px;padding:32px 28px;">
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;">Confirmá tu lugar</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:21px;color:#6C6C70;">Pediste que te avisemos cuando Rollo abra para todos. Confirmá tu email para quedar en la lista.</p>
    <a href="${escapeHtml(confirmUrl)}" style="display:block;padding:14px 20px;border-radius:14px;background:#3155F5;color:#FFFFFF;font-size:17px;font-weight:600;text-decoration:none;text-align:center;">Confirmar</a>
    <p style="margin:24px 0 0;font-size:13px;line-height:18px;color:#8E8E93;">Si no fuiste vos, ignorá este mensaje: sin confirmar no te escribimos más.<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#8E8E93;">Darme de baja de la lista</a></p>
  </div>
</body>
</html>`;
  return { subject, text, html };
}
