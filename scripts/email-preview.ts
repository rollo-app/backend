import { writeFileSync } from "node:fs";
import { renderLoginEmail } from "../src/lib/login-email";

/** Writes the login email HTML to `login-email-preview.html` so it can be opened in a browser: `npm run email:preview`. */
const { html } = renderLoginEmail({
  code: "ABC234",
  url: "https://rollo.juanifraga.com/entrar#t=sampletoken&e=juani%40rollo.test",
});
writeFileSync("login-email-preview.html", html);
console.log("login-email-preview.html written");
