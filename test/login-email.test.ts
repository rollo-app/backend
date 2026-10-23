import { describe, expect, it } from "vitest";
import { renderLoginEmail } from "../src/lib/login-email";

const URL_WITH_AMP = "https://rollo.juanifraga.com/entrar#t=abc&e=a%40b.com";

describe("renderLoginEmail", () => {
  it("builds the subject with the code", () => {
    expect(renderLoginEmail({ code: "ABC234", url: null }).subject).toBe("Tu código de Rollo: ABC234");
  });

  it("puts the unsplit code and the word 'código' in the html", () => {
    const { html } = renderLoginEmail({ code: "ABC234", url: null });
    expect(html).toContain(">ABC234<");
    expect(html).toContain("código");
    expect(html).toContain("user-select:all");
  });

  it("escapes the code", () => {
    const { html } = renderLoginEmail({ code: "<b>", url: null });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("puts the escaped url in the button href", () => {
    const { html } = renderLoginEmail({ code: "ABC234", url: URL_WITH_AMP });
    expect(html).toContain('href="https://rollo.juanifraga.com/entrar#t=abc&amp;e=a%40b.com"');
    expect(html).toContain("Abrir Rollo");
    expect(html).toContain("iPhone");
  });

  it("has no button nor iPhone paragraph without a url", () => {
    const { html } = renderLoginEmail({ code: "ABC234", url: null });
    expect(html).not.toContain("<a");
    expect(html).not.toContain("Abrir Rollo");
    expect(html).not.toContain("iPhone");
    expect(html).toContain("Vence en 5 minutos");
  });

  it("includes the code and url in the plain text", () => {
    const { text } = renderLoginEmail({ code: "ABC234", url: URL_WITH_AMP });
    expect(text).toContain("Tu código de Rollo es ABC234. Vence en 5 minutos.");
    expect(text).toContain(URL_WITH_AMP);
  });

  it("leaves the link out of the plain text without a url", () => {
    const { text } = renderLoginEmail({ code: "ABC234", url: null });
    expect(text).toContain("ABC234");
    expect(text).not.toContain("link");
    expect(text).toContain("Si no lo pediste, ignorá este mensaje.");
  });
});
