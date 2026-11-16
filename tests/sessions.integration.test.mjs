import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { createDatabaseClient } from "../dist/database/client.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { createSessionService, sessionHash, sessionAbsoluteMs, sessionIdleMs } from "../dist/auth/sessions.js";
import { tokenIssuer, tokenAudience } from "../dist/auth/token.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
let now = new Date();
const origin = "http://127.0.0.1:5173", password = "Synthetic refresh session passphrase!";
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900, corsOrigins: [origin], rateLimit: { limit: 1000, windowMs: 60000 }, sessions: { clock: () => new Date(now) } };
const app = createApp(async () => {}, options);
const service = createSessionService(database, options.jwtSecret, options.sessions.clock);
const suffix = `@${randomUUID()}.sessions.fixit.test`;
let client, master;
const csrf = (call) => call.set("Origin", origin).set("X-FixIT-CSRF", "1");
const post = (path, target = app) => csrf(request(target).post("/api/v1/auth/" + path));
const cookie = (response) => response.headers["set-cookie"][0].split(";")[0];
const token = (value) => value.slice(value.indexOf("=") + 1);
const id = (value) => token(value).split(".")[1];
const refresh = (value, target = app) => post("refresh", target).set("Cookie", value).send({});
const logout = (value, target = app) => post("logout", target).set("Cookie", value).send({});
const row = (value) => database.authSession.findUniqueOrThrow({ where: { id: id(value) } });
async function login(actor = client, target = app) {
  return post("login", target).send({ email: actor.email, password }).expect(200);
}
async function account(role) {
  const email = role.toLowerCase() + suffix;
  const result = await post("register").send({ name: `Synthetic ${role}`, email, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city: "Session test city", category: "OTHER", profileDescription: "Synthetic", serviceTitle: "Synthetic", serviceDescription: "Synthetic" } : {}) }).expect(201);
  return result.body.user;
}
beforeAll(async () => { await database.$connect(); client = await account("CLIENT"); master = await account("MASTER"); });
beforeEach(() => { now = new Date(); });
afterAll(async () => { await database.$disconnect(); }); // Retain only this synthetic cohort in the new *_test DB.

describe("refresh issuance, rotation and replay", () => {
  test("login preserves public contract and stores only SHA-256, with absolute/idle metadata", async () => {
    const response = await login(), c = cookie(response), stored = await row(c);
    expect(Object.keys(response.body).sort()).toEqual(["accessToken", "expiresIn", "tokenType", "user"]);
    expect(response.body).toMatchObject({ expiresIn: 900, tokenType: "Bearer", user: client });
    expect(stored).toMatchObject({ userId: client.id, generation: 0, tokenHash: sessionHash(token(c)), previousTokenHash: null, revokedAt: null });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(sessionAbsoluteMs);
    expect(JSON.stringify(stored)).not.toContain(token(c)); expect(stored.tokenHash).toHaveLength(64);
    expect(response.headers["set-cookie"][0]).toMatch(/HttpOnly/); expect(response.headers["set-cookie"][0]).toMatch(/SameSite=Lax/);
    expect(response.headers["set-cookie"][0]).toMatch(/Path=\//); expect(response.headers["set-cookie"][0]).not.toMatch(/Domain=|Secure/);
    expect(response.headers["cache-control"]).toBe("no-store"); expect(JSON.stringify(response.body)).not.toMatch(/refresh|tokenHash|passwordHash/i);
  });
  test("failed login creates no session and does not set a cookie", async () => {
    const count = await database.authSession.count({ where: { userId: client.id } });
    const result = await post("login").send({ email: client.email, password: "Synthetic wrong password" }).expect(401);
    expect(result.headers["set-cookie"]).toBeUndefined(); expect(await database.authSession.count({ where: { userId: client.id } })).toBe(count);
  });
  test("refresh state survives a new API instance with the same server key", async () => {
    const current = cookie(await login()), restarted = createApp(async () => {}, options);
    expect((await refresh(current, restarted).expect(200)).body.user.id).toBe(client.id);
  });
  test("explicit account switch replaces the cookie session without adopting the earlier user", async () => {
    const old = cookie(await login()); const changed = await post("login").set("Cookie", old).send({ email: master.email, password }).expect(200);
    expect(changed.body.user.id).toBe(master.id); await refresh(old).expect(401);
    expect((await refresh(cookie(changed)).expect(200)).body.user.id).toBe(master.id);
  });
  test("refresh rotates once, returns unique access JWT with preserved issuer/audience and no refresh payload", async () => {
    const first = await login(), old = cookie(first), before = await row(old); now = new Date(now.getTime() + 5);
    const next = await refresh(old).expect(200), current = cookie(next), after = await row(current);
    expect(current).not.toBe(old); expect(after.generation).toBe(1); expect(after.previousTokenHash).toBe(before.tokenHash);
    expect(after.tokenHash).toBe(sessionHash(token(current))); expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.lastUsedAt).toEqual(now); expect(after.rotatedAt).toEqual(now);
    expect(next.body.accessToken).not.toBe(first.body.accessToken);
    const claims = jwt.verify(next.body.accessToken, options.jwtSecret, { algorithms: ["HS256"], issuer: tokenIssuer, audience: tokenAudience });
    expect(claims.sub).toBe(client.id); expect(claims.exp - claims.iat).toBe(900);
    expect(JSON.stringify(claims)).not.toContain(id(old)); expect(JSON.stringify(next.body)).not.toContain(token(current));
  });
  test("immediate old verifier gets 409, no credentials or Set-Cookie and no session destruction", async () => {
    const first = cookie(await login()), next = cookie(await refresh(first).expect(200));
    const conflict = await refresh(first).expect(409);
    expect(conflict.body.error.code).toBe("REFRESH_CONFLICT"); expect(conflict.body.accessToken).toBeUndefined(); expect(conflict.body.user).toBeUndefined();
    expect(conflict.headers["set-cookie"]).toBeUndefined(); expect((await row(next)).revokedAt).toBeNull();
    await refresh(next).expect(200);
  });
  test("parallel refresh: exactly one winner, loser has no credentials and cannot erase winner cookie", async () => {
    const first = cookie(await login()); const results = await Promise.all([refresh(first), refresh(first)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const success = results.find((r) => r.status === 200), conflict = results.find((r) => r.status === 409);
    expect(conflict.headers["set-cookie"]).toBeUndefined(); expect(conflict.body.accessToken).toBeUndefined();
    expect((await row(first)).generation).toBe(1); await refresh(cookie(success)).expect(200);
  });
  test("authenticated stale generations get no credentials during the short window", async () => {
    const first = cookie(await login()), second = cookie(await refresh(first)), third = cookie(await refresh(second));
    await refresh(first).expect(409); expect((await row(third)).revokedAt).toBeNull();
  });
  test("replay after 2s revokes the family; other session remains usable", async () => {
    const first = cookie(await login()), unrelated = cookie(await login(master));
    const current = cookie(await refresh(first).expect(200)); now = new Date(now.getTime() + 2100);
    const denied = await refresh(first).expect(401); expect(denied.headers["set-cookie"]).toBeUndefined();
    expect((await row(current)).revokedReason).toBe("replay"); await refresh(current).expect(401);
    expect((await refresh(unrelated).expect(200)).body.user.id).toBe(master.id);
  });
  test("older-than-previous authenticated token is detected without storing all old hashes", async () => {
    const first = cookie(await login()), second = cookie(await refresh(first)), current = cookie(await refresh(second));
    now = new Date(now.getTime() + 2100); await refresh(first).expect(401); expect((await row(current)).revokedReason).toBe("replay");
  });
  test("selector/counter/verifier/tag forgery never revokes a valid session", async () => {
    const good = cookie(await login()); const parts = token(good).split(".");
    for (const [index, value] of [[1, randomUUID()], [2, "99"], [3, "a".repeat(43)], [4, "b".repeat(43)]]) {
      const forged = [...parts]; forged[index] = value;
      await refresh("fixit_refresh_dev=" + forged.join(".")).expect(401);
    }
    expect((await row(good)).revokedAt).toBeNull(); await refresh(good).expect(200);
  });
});

describe("logout, expiry and identity isolation", () => {
  test("logout revokes and clears matching cookie attributes, repeat is idempotent", async () => {
    const good = cookie(await login()); const out = await logout(good).expect(204);
    expect(out.headers["set-cookie"][0]).toMatch(/fixit_refresh_dev=; Path=\/; Expires=/);
    expect(out.headers["set-cookie"][0]).toMatch(/HttpOnly; SameSite=Lax/);
    const before = await row(good); expect(before.revokedReason).toBe("logout");
    await logout(good).expect(204); expect(await row(good)).toEqual(before); await refresh(good).expect(401);
  });
  test("logout using an earlier valid verifier also revokes an in-flight rotated session", async () => {
    const old = cookie(await login()), current = cookie(await refresh(old)); await logout(old).expect(204); await refresh(current).expect(401);
  });
  test("missing/malformed cookie logout does not affect another session", async () => {
    const good = cookie(await login()); await post("logout").send({}).expect(204); await logout("fixit_refresh_dev=invalid").expect(204);
    expect((await row(good)).revokedAt).toBeNull(); await refresh(good).expect(200);
  });
  test("already-issued access JWT remains valid until TTL after refresh-session logout", async () => {
    const signed = await login(); await logout(cookie(signed)).expect(204);
    expect((await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${signed.body.accessToken}`).expect(200)).body.user.id).toBe(client.id);
  });
  test.each(["absolute", "idle"])("%s deadline rejects and records expiry, without extending the session", async (kind) => {
    const good = cookie(await login()); now = new Date(now.getTime() + (kind === "absolute" ? sessionAbsoluteMs : sessionIdleMs));
    await refresh(good).expect(401); expect((await row(good)).revokedReason).toBe("expired");
  });
  test("successful activity resets idle time but cannot extend absolute expiry", async () => {
    const good = cookie(await login()), before = await row(good); now = new Date(now.getTime() + sessionIdleMs - 1);
    const next = cookie(await refresh(good).expect(200)); expect((await row(next)).expiresAt).toEqual(before.expiresAt); expect((await row(next)).lastUsedAt).toEqual(now);
  });
  test("deleted user cannot refresh; cascading technical sessions do not block deletion", async () => {
    const user = await database.user.create({ data: { email: randomUUID() + suffix, name: "Synthetic deleted", passwordHash: "synthetic-unused-hash", role: "CLIENT" } });
    const value = await service.create(user.id); await database.user.delete({ where: { id: user.id } });
    expect(await database.authSession.count({ where: { userId: user.id } })).toBe(0); await refresh("fixit_refresh_dev=" + value.token).expect(401);
  });
  test("CLIENT and MASTER refresh current roles separately and me DTO has no session fields", async () => {
    for (const actor of [client, master]) {
      const result = await refresh(cookie(await login(actor))).expect(200); expect(result.body.user).toEqual(actor);
      const me = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${result.body.accessToken}`).expect(200);
      expect(Object.keys(me.body.user).sort()).toEqual(["email", "id", "name", "role"]);
    }
  });
  test("Bearer header cannot override the cookie owner's refresh identity", async () => {
    const owner = cookie(await login()), unrelated = await login(master);
    const result = await refresh(owner).set("Authorization", `Bearer ${unrelated.body.accessToken}`).expect(200); expect(result.body.user.id).toBe(client.id);
  });
});

describe("cookie/CSRF/rate boundaries", () => {
  test("production cookie is __Host, Secure, HttpOnly, Lax, Path=/ and host-only", async () => {
    const secure = createApp(async () => {}, { ...options, sessions: { ...options.sessions, secure: true } });
    const result = await login(client, secure), header = result.headers["set-cookie"][0];
    expect(header).toMatch(/^__Host-fixit_refresh=/); expect(header).toMatch(/; Secure/); expect(header).toMatch(/; HttpOnly/); expect(header).toMatch(/; SameSite=Lax/); expect(header).not.toMatch(/Domain=/);
    const out = await logout(cookie(result), secure).expect(204); expect(out.headers["set-cookie"][0]).toMatch(/__Host-fixit_refresh=; Path=\/; Expires=.*HttpOnly; Secure; SameSite=Lax/);
  });
  test("production auth refuses plain HTTP outside loopback and supports verified ingress protocol", async () => {
    const secure = createApp(async () => {}, { ...options, sessions: { ...options.sessions, secure: true } }, { trustProxyHops: 1 });
    await post("login", secure).set("Host", "fixit.example.test").send({ email: client.email, password }).expect(403);
    const accepted = await post("login", secure).set("Host", "fixit.example.test").set("X-Forwarded-Proto", "https").send({ email: client.email, password }).expect(200);
    expect(accepted.headers["set-cookie"][0]).toContain("; Secure");
  });
  test.each(["login", "register", "refresh", "logout"])("%s rejects missing Origin/header/form and untrusted Origin", async (path) => {
    await request(app).post(`/api/v1/auth/${path}`).set("X-FixIT-CSRF", "1").send({}).expect(403);
    await request(app).post(`/api/v1/auth/${path}`).set("Origin", origin).send({}).expect(403);
    await post(path).set("Origin", "https://untrusted.example").send({}).expect(403);
    await post(path).set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
    await post(path).type("form").send({}).expect(403);
  });
  test("trusted credentialed preflight allows only explicit origin and CSRF header", async () => {
    const preflight = await request(app).options("/api/v1/auth/refresh").set("Origin", origin).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "x-fixit-csrf,content-type").expect(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(origin); expect(preflight.headers["access-control-allow-credentials"]).toBe("true"); expect(preflight.headers["access-control-allow-headers"]).toContain("X-FixIT-CSRF");
  });
  test("insecure dev cookie cannot be used with a non-loopback Host or forwarding-host spoof", async () => {
    await post("login").set("Host", "untrusted.example").set("X-Forwarded-Host", "localhost").send({ email: client.email, password }).expect(403);
  });
  test.each(["", "invalid", "v1.invalid", "x".repeat(500)])("missing/malformed cookie %# returns safe 401 without Set-Cookie", async (value) => {
    const result = await refresh("fixit_refresh_dev=" + value).expect(401); expect(result.headers["set-cookie"]).toBeUndefined(); expect(JSON.stringify(result.body)).not.toContain(password);
  });
  test("duplicate same-name cookies are rejected instead of choosing one", async () => { const good = cookie(await login()); await refresh(good + "; " + good).expect(401); expect((await row(good)).revokedAt).toBeNull(); });
  test("no cookie at all is a safe 401", async () => { const result = await post("refresh").send({}).expect(401); expect(result.headers["set-cookie"]).toBeUndefined(); });
  test.each(["refresh", "logout"])("%s accepts no body/query identity or token override", async (path) => {
    const good = cookie(await login());
    for (const body of [{ userId: master.id }, { refreshToken: token(good) }, { role: "ADMIN" }]) await post(path).set("Cookie", good).send(body).expect(400);
    await post(path).set("Cookie", good).query({ userId: master.id }).send({}).expect(400); expect((await row(good)).revokedAt).toBeNull();
  });
  test("valid refresh rate limit is per authenticated session, not a shared IP or selector guess", async () => {
    const limited = createApp(async () => {}, { ...options, sessions: { ...options.sessions, refreshLimit: 1 } });
    const first = cookie(await login(client, limited)), other = cookie(await login(master, limited));
    const next = cookie(await refresh(first, limited).expect(200)); await refresh(next, limited).expect(429);
    expect((await row(next)).revokedAt).toBeNull(); await refresh(other, limited).expect(200);
  });
  test("invalid-cookie flooding cannot exhaust the active-session limiter", async () => {
    const isolated = createApp(async () => {}, options), good = cookie(await login(client, isolated));
    for (let i = 0; i < 61; i++) await refresh("fixit_refresh_dev=invalid", isolated).expect(i < 60 ? 401 : 429);
    await refresh(good, isolated).expect(200); expect((await row(good)).revokedAt).toBeNull();
  });
  test("refresh credentials never appear in response DTOs or application logs", async () => {
    const logs = [jest.spyOn(console, "log").mockImplementation(() => {}), jest.spyOn(console, "error").mockImplementation(() => {}), jest.spyOn(console, "warn").mockImplementation(() => {})];
    try {
      const first = await login(), second = await refresh(cookie(first)).expect(200); await logout(cookie(second)).expect(204);
      const output = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      for (const c of [cookie(first), cookie(second)]) { expect(output.includes(token(c))).toBe(false); expect(JSON.stringify(second.body).includes(token(c))).toBe(false); }
    } finally { logs.forEach((spy) => spy.mockRestore()); }
  });
  test.each(["foreign-key", "unique", "hash", "generation", "time", "revocation"])("SQL %s constraint protects technical sessions", async (kind) => {
    const data = { userId: client.id, tokenHash: randomBytes(32).toString("hex"), createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + sessionAbsoluteMs) };
    if (kind === "foreign-key") data.userId = randomUUID();
    if (kind === "unique") await database.authSession.create({ data });
    if (kind === "hash") data.tokenHash = "invalid";
    if (kind === "generation") data.generation = 1;
    if (kind === "time") data.expiresAt = now;
    if (kind === "revocation") data.revokedAt = now;
    await expect(database.authSession.create({ data })).rejects.toThrow();
  });
  test("login/refresh/logout never modify business rows or SQL status history", async () => {
    const before = await database.$transaction([database.user.findMany({ orderBy: { id: "asc" } }), database.order.findMany({ orderBy: { id: "asc" } }), database.service.findMany({ orderBy: { id: "asc" } })]);
    const next = cookie(await refresh(cookie(await login())).expect(200)); await logout(next).expect(204);
    const after = await database.$transaction([database.user.findMany({ orderBy: { id: "asc" } }), database.order.findMany({ orderBy: { id: "asc" } }), database.service.findMany({ orderBy: { id: "asc" } })]); expect(after).toEqual(before);
  });
});
