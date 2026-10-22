import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { areFriends, canSeeProfile } from "../src/lib/profile-access";
import { api, befriend, signUp } from "./helpers";

async function setVisibility(token: string, profileVisibility: "friends" | "public") {
  const res = await api("PATCH", "/me", { token, body: { profileVisibility } });
  if (res.status !== 200) throw new Error(`PATCH /me failed: ${res.status} ${JSON.stringify(res.body)}`);
}

describe("areFriends", () => {
  it("is true in both orders once they are friends", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    expect(await areFriends(env.DB, a.userId, b.userId)).toBe(false);
    expect(await areFriends(env.DB, b.userId, a.userId)).toBe(false);
    await befriend(a.token, b.token);
    expect(await areFriends(env.DB, a.userId, b.userId)).toBe(true);
    expect(await areFriends(env.DB, b.userId, a.userId)).toBe(true);
  });

  it("is false for yourself", async () => {
    const a = await signUp();
    expect(await areFriends(env.DB, a.userId, a.userId)).toBe(false);
  });
});

describe("canSeeProfile", () => {
  it("lets you see your own private profile", async () => {
    const a = await signUp();
    expect(await canSeeProfile(env.DB, a.userId, { id: a.userId, profile_visibility: "friends" })).toBe(true);
  });

  it("lets a friend see a private profile", async () => {
    const a = await signUp();
    const b = await signUp();
    await befriend(a.token, b.token);
    expect(await canSeeProfile(env.DB, b.userId, { id: a.userId, profile_visibility: "friends" })).toBe(true);
  });

  it("hides a private profile from a stranger", async () => {
    const a = await signUp();
    const b = await signUp();
    expect(await canSeeProfile(env.DB, b.userId, { id: a.userId, profile_visibility: "friends" })).toBe(false);
  });

  it("shows a public profile to a stranger", async () => {
    const a = await signUp();
    const b = await signUp();
    expect(await canSeeProfile(env.DB, b.userId, { id: a.userId, profile_visibility: "public" })).toBe(true);
  });
});

describe("GET /users/{userId}", () => {
  async function owner() {
    const o = await signUp(undefined, "Cami", `cami${Math.random().toString(36).slice(2, 8)}`);
    await api("PATCH", "/me", { token: o.token, body: { bio: "Fotos de montaña" } });
    return o;
  }

  it("shows your own profile with the bio", async () => {
    const o = await owner();
    const res = await api("GET", `/users/${o.userId}`, { token: o.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: o.userId, name: "Cami", username: expect.any(String), avatarUrl: null, bio: "Fotos de montaña" },
      isFriend: false,
      profileVisibility: "friends",
      canSee: true,
    });
  });

  it("shows a friend's private profile with the bio", async () => {
    const o = await owner();
    const v = await signUp();
    await befriend(o.token, v.token);
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isFriend: true, profileVisibility: "friends", canSee: true });
    expect(res.body.user.bio).toBe("Fotos de montaña");
  });

  it("hides the bio of a private profile from a stranger but keeps name, username and avatar", async () => {
    const o = await owner();
    const v = await signUp();
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: o.userId, name: "Cami", username: expect.any(String), avatarUrl: null, bio: null },
      isFriend: false,
      profileVisibility: "friends",
      canSee: false,
    });
  });

  it("shows a public profile to a stranger", async () => {
    const o = await owner();
    await setVisibility(o.token, "public");
    const v = await signUp();
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isFriend: false, profileVisibility: "public", canSee: true });
    expect(res.body.user.bio).toBe("Fotos de montaña");
  });

  it("does not leak the email", async () => {
    const o = await owner();
    const res = await api("GET", `/users/${o.userId}`, { token: o.token });
    expect(Object.keys(res.body.user).sort()).toEqual(["avatarUrl", "bio", "id", "name", "username"]);
  });

  it("returns 404 for an unknown user", async () => {
    const v = await signUp();
    const res = await api("GET", `/users/${crypto.randomUUID()}`, { token: v.token });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No existe" });
  });

  it("requires a session", async () => {
    const o = await owner();
    expect((await api("GET", `/users/${o.userId}`)).status).toBe(401);
  });
});
