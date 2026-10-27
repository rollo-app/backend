import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { areFriends } from "../src/modules/friends/friends.service";
import { canSeeProfile } from "../src/modules/users/users.service";
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
      user: { id: o.userId, name: "Cami", username: expect.any(String), avatarUrl: null, bio: "Fotos de montaña", badge: null },
      isFriend: false,
      blockedByMe: false,
      reportedByMe: false,
      profileVisibility: "friends",
      canSee: true,
      friendCount: 0,
      mutualCount: 0,
      friendRequest: "none",
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

  it("shows the bio of a private profile to a stranger (the bio is always public)", async () => {
    const o = await owner();
    const v = await signUp();
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: o.userId, name: "Cami", username: expect.any(String), avatarUrl: null, bio: "Fotos de montaña", badge: null },
      isFriend: false,
      blockedByMe: false,
      reportedByMe: false,
      profileVisibility: "friends",
      canSee: false,
      friendCount: 0,
      mutualCount: 0,
      friendRequest: "none",
    });
  });

  it("counts the user's friends and the friends in common with the viewer", async () => {
    const o = await owner();
    const v = await signUp();
    const [m1, m2, onlyOwner, onlyViewer] = await Promise.all([signUp(), signUp(), signUp(), signUp()]);
    for (const f of [m1, m2, onlyOwner]) await befriend(o.token, f.token);
    for (const f of [m1, m2, onlyViewer]) await befriend(v.token, f.token);
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ friendCount: 3, mutualCount: 2 });
  });

  it("counts a friend viewer among the friends but not among the mutuals", async () => {
    const o = await owner();
    const v = await signUp();
    const other = await signUp();
    await befriend(o.token, v.token);
    await befriend(o.token, other.token);
    const res = await api("GET", `/users/${o.userId}`, { token: v.token });
    expect(res.body).toMatchObject({ friendCount: 2, mutualCount: 0 });
  });

  it("reports 0 mutuals on your own profile", async () => {
    const o = await owner();
    const f = await signUp();
    await befriend(o.token, f.token);
    const res = await api("GET", `/users/${o.userId}`, { token: o.token });
    expect(res.body).toMatchObject({ friendCount: 1, mutualCount: 0 });
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
    expect(Object.keys(res.body.user).sort()).toEqual(["avatarUrl", "badge", "bio", "id", "name", "username"]);
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

describe("GET /users/{userId}/friends", () => {
  async function named(name: string) {
    return signUp(undefined, name);
  }

  async function ownerWithFriends() {
    const o = await signUp(undefined, "Cami");
    const bruno = await named("bruno");
    const ana = await named("Ana");
    const zoe = await named("Zoe");
    for (const f of [bruno, ana, zoe]) await befriend(o.token, f.token);
    return { o, bruno, ana, zoe };
  }

  const ids = (body: { friends: { id: string }[] }) => body.friends.map((f) => f.id);

  it("lists all your own friends sorted by name, case-insensitive", async () => {
    const { o, bruno, ana, zoe } = await ownerWithFriends();
    const res = await api("GET", `/users/${o.userId}/friends`, { token: o.token });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("all");
    expect(ids(res.body)).toEqual([ana.userId, bruno.userId, zoe.userId]);
  });

  it("returns only id, name, username and avatarUrl for each friend", async () => {
    const { o, ana } = await ownerWithFriends();
    await api("PATCH", "/me", { token: ana.token, body: { bio: "secreto" } });
    const res = await api("GET", `/users/${o.userId}/friends`, { token: o.token });
    expect(res.body.friends[0]).toEqual({ id: ana.userId, name: "Ana", username: expect.any(String), avatarUrl: null });
  });

  it("lists all friends of a friend with a private profile", async () => {
    const { o, bruno, ana, zoe } = await ownerWithFriends();
    const res = await api("GET", `/users/${o.userId}/friends`, { token: bruno.token });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("all");
    expect(ids(res.body)).toEqual([ana.userId, bruno.userId, zoe.userId]);
  });

  it("lists all friends of a stranger with a public profile", async () => {
    const { o, bruno, ana, zoe } = await ownerWithFriends();
    await setVisibility(o.token, "public");
    const v = await signUp();
    const res = await api("GET", `/users/${o.userId}/friends`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("all");
    expect(ids(res.body)).toEqual([ana.userId, bruno.userId, zoe.userId]);
  });

  it("lists only the mutual friends of a stranger with a private profile", async () => {
    const { o, ana, zoe } = await ownerWithFriends();
    const v = await signUp();
    const onlyViewer = await signUp();
    await befriend(v.token, zoe.token);
    await befriend(v.token, ana.token);
    await befriend(v.token, onlyViewer.token);
    const res = await api("GET", `/users/${o.userId}/friends`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("mutual");
    expect(ids(res.body)).toEqual([ana.userId, zoe.userId]);
  });

  it("lists nothing for a stranger with a private profile and no mutuals", async () => {
    const { o } = await ownerWithFriends();
    const v = await signUp();
    const res = await api("GET", `/users/${o.userId}/friends`, { token: v.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: "mutual", friends: [] });
  });

  it("returns 404 for an unknown user", async () => {
    const v = await signUp();
    const res = await api("GET", `/users/${crypto.randomUUID()}/friends`, { token: v.token });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No existe" });
  });

  it("requires a session", async () => {
    const { o } = await ownerWithFriends();
    expect((await api("GET", `/users/${o.userId}/friends`)).status).toBe(401);
  });
});
