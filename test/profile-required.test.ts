import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers";

const MESSAGE = "Completá tu perfil";

describe("complete profile required", () => {
  it("an account without a name gets 428 on a profile-gated route", async () => {
    const { token } = await signUp(undefined, null);
    const res = await api("GET", "/me/trips", { token });
    expect(res.status).toBe(428);
    expect(res.body).toEqual({ error: MESSAGE });
  });

  it("an account without a username gets 428 on a profile-gated route", async () => {
    const { token } = await signUp(undefined, "Fede", null);
    const res = await api("GET", "/me/trips", { token });
    expect(res.status).toBe(428);
    expect(res.body).toEqual({ error: MESSAGE });
  });

  it("the profile step routes work without a complete profile", async () => {
    const { token } = await signUp(undefined, null, null);
    expect((await api("GET", "/me", { token })).status).toBe(200);
    expect((await api("GET", "/usernames/nuevo_user", { token })).status).toBe(200);
    expect((await api("POST", "/me/avatar", { token, body: { sizeBytes: 1000 } })).status).toBe(200);
    expect((await api("PATCH", "/me", { token, body: { name: "Fede", username: "fede_nuevo" } })).status).toBe(200);
    expect((await api("GET", "/me/trips", { token })).status).toBe(200);
  });

  it("logout and account deletion work without a complete profile", async () => {
    const a = await signUp(undefined, null, null);
    expect((await api("POST", "/auth/logout", { token: a.token })).status).toBe(204);
    const b = await signUp(undefined, null, null);
    expect((await api("DELETE", "/me", { token: b.token })).status).toBe(204);
  });

  it("every router gates incomplete accounts", async () => {
    const other = await signUp();
    const { token } = await signUp(undefined, null, null);
    const calls: [string, string, unknown?][] = [
      ["GET", "/friends"],
      ["GET", "/me/friend-requests"],
      ["GET", "/me/likes"],
      ["GET", "/me/comments"],
      ["POST", "/trips/join", { code: "ABCDEF" }],
      ["GET", "/blocks"],
      [ "GET", `/users/${other.userId}`],
      ["GET", "/me/moments"],
      ["GET", "/me/settings"],
      ["POST", "/friends/link"],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, { token, body });
      expect([method, path, res.status]).toEqual([method, path, 428]);
    }
  });
});
