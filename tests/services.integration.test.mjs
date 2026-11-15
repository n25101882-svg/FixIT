import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { createDatabaseClient, checkDatabase } from "../dist/database/client.js";
import { issueToken } from "../dist/auth/token.js";
import { createOrderService } from "../dist/orders/service.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900, corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 } };
const app = createApp(() => checkDatabase(database), options); const commands = createOrderService(database);
const suffix = `@${randomUUID()}.catalog-api.fixit.test`; const city = `Місто ${randomUUID().slice(0, 8)}`; const needle = `catalog-${randomUUID()}`;
let a, b, client;
const accountIds = [];
async function account(name, role = "MASTER", profile = {}) {
  const password = randomBytes(24).toString("hex");
  const created = await request(app).post("/api/v1/auth/register").send({ email: name + suffix, name: `Synthetic ${name}`, role, password, passwordConfirmation: password,
    ...(role === "MASTER" ? { city, category: "TECH_REPAIR", profileDescription: "Synthetic profile", serviceTitle: "Synthetic initial service", serviceDescription: "Synthetic initial description", ...profile } : {}) }).expect(201);
  const user = created.body.user; accountIds.push(user.id); return { ...user, token: issueToken(user.id, options), profile: await database.masterProfile.findUnique({ where: { userId: user.id } }) };
}
const call = (actor, method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${actor.token}`);
const input = { title: "Синтетична послуга", category: "PLUMBING", description: "Синтетичний опис" };
const create = async (body = {}, actor = a) => (await call(actor, "post", "/master/services").send({ ...input, ...body }).expect(201)).body.service;
const patch = (actor, id, body) => call(actor, "patch", `/master/services/${id}`).send(body);
const catalog = (query = {}) => request(app).get("/api/v1/catalog/services").query(query);
const profile = (actor = a) => call(actor, "get", "/master/profile");
const publicProfile = (id, query = {}) => request(app).get(`/api/v1/catalog/masters/${id}`).query(query);
const safe = (value) => expect(JSON.stringify(value)).not.toMatch(/email|passwordHash|userId|actorUserId|statusHistory|isApproved|accessToken|"orders"/i);
beforeAll(async () => { await database.$connect(); a = await account("master-a"); b = await account("master-b", "MASTER", { city: `Інше ${city}` }); client = await account("client", "CLIENT"); });
afterAll(async () => {
  // Only this suite's synthetic IDs; selected histories from other suites remain.
  const users = { id: { in: accountIds } };
  await database.$transaction(async (tx) => {
    await tx.orderResponse.deleteMany({ where: { order: { client: users } } });
    await tx.order.deleteMany({ where: { client: users } });
    await tx.service.deleteMany({ where: { masterProfile: { user: users } } });
    await tx.masterProfile.deleteMany({ where: { user: users } }); await tx.user.deleteMany({ where: users });
  }); await database.$disconnect();
});
const privateRoutes = [["get", "/master/profile"], ["patch", "/master/profile"], ["get", "/master/services"], ["post", "/master/services"], ["patch", `/master/services/${randomUUID()}`]];
describe("MASTER services boundary", () => {
  test.each(privateRoutes)("%s %s requires JWT", async (method, path) => { await request(app)[method](`/api/v1${path}`).send({}).expect(401); });
  test.each(privateRoutes)("CLIENT cannot %s %s even with an invalid body", async (method, path) => { await call(client, method, path).send({}).expect(403); });
  test("internal ADMIN has no MASTER privileges", async () => {
    const user = await database.user.create({ data: { email: "admin" + suffix, name: "Synthetic internal", role: "ADMIN", passwordHash: "synthetic-unused-hash" } });
    accountIds.push(user.id);
    for (const [method, path] of privateRoutes) await call({ token: issueToken(user.id, options) }, method, path).send({}).expect(403);
  });
  test.each(["invalid", "expired", "deleted"])("%s account/token cannot access private data", async (kind) => {
    const token = kind === "invalid" ? "invalid.token" : issueToken(kind === "deleted" ? randomUUID() : a.id, { ...options, tokenTtlSeconds: kind === "expired" ? -10 : 900 });
    await profile({ token }).expect(401);
  });
  test("MASTER with no profile receives 403", async () => {
    const user = await database.user.create({ data: { email: "legacy" + suffix, name: "Synthetic legacy", role: "MASTER", passwordHash: "synthetic-unused-hash" } });
    accountIds.push(user.id);
    await profile({ token: issueToken(user.id, options) }).expect(403);
  });
  test("own profile and services expose only allowed fields", async () => {
    const p = (await profile().expect(200)).body.profile; expect(p).toMatchObject({ id: a.profile.id, name: a.name, city }); safe(p);
    const rows = (await call(a, "get", "/master/services").expect(200)).body.services;
    const expected = await database.service.findMany({ where: { masterProfileId: a.profile.id }, select: { id: true } });
    expect(rows.map((s) => s.id).sort()).toEqual(expected.map((s) => s.id).sort()); safe(rows);
  });
  test("unknown and foreign service have the same safe 404", async () => {
    const service = await create(); const before = await database.service.findUniqueOrThrow({ where: { id: service.id } });
    const foreign = await patch(b, service.id, { title: "Intrusion" }).expect(404);
    const unknown = await patch(b, randomUUID(), { title: "Intrusion" }).expect(404);
    expect(foreign.body).toEqual(unknown.body); expect(await database.service.findUniqueOrThrow({ where: { id: service.id } })).toEqual(before);
  });
  test("foreign profile cannot be addressed or supplied in the payload", async () => {
    const before = await database.masterProfile.findUniqueOrThrow({ where: { id: b.profile.id } });
    await call(a, "patch", `/master/profile/${b.profile.id}`).send({ city: "Intrusion" }).expect(404);
    await call(a, "patch", "/master/profile").send({ id: b.profile.id, city: "Intrusion" }).expect(400);
    expect(await database.masterProfile.findUniqueOrThrow({ where: { id: b.profile.id } })).toEqual(before);
  });
  test("service UUID and private query overrides are validated", async () => {
    await patch(a, "invalid", { title: "Synthetic" }).expect(400);
    await call(a, "get", "/master/services").query({ masterProfileId: b.profile.id }).expect(400);
    await call(a, "get", "/master/profile").query({ userId: b.id }).expect(400);
  });
});
describe("profile/service mutations and nullable exact prices", () => {
  test("201 creates an owned service with an independent category and null optional values", async () => {
    const created = await create({ title: "  Ремонт   крана  ", description: " " });
    expect(created).toMatchObject({ title: "Ремонт крана", category: "PLUMBING", priceEstimate: null, description: null, isActive: true }); safe(created);
    expect((await database.service.findUniqueOrThrow({ where: { id: created.id } })).masterProfileId).toBe(a.profile.id);
    expect((await profile()).body.profile.category).toBe("TECH_REPAIR");
  });
  test.each([[undefined, null], [null, null], ["0", "0.00"], ["12.30", "12.30"], ["99999999.99", "99999999.99"]])("price %s remains exact, never silently becomes zero", async (priceEstimate, expected) => {
    const row = await create({ priceEstimate }); expect(row.priceEstimate).toBe(expected);
    const stored = await database.service.findUniqueOrThrow({ where: { id: row.id } }); expect(stored.priceEstimate?.toFixed(2) ?? null).toBe(expected);
  });
  test("PATCH edits allowed fields, preserves omitted price, clears it explicitly and toggles visibility", async () => {
    const row = await create({ priceEstimate: "123.45" });
    expect((await patch(a, row.id, { title: "Нова назва", category: "ELECTRICAL", description: null }).expect(200)).body.service).toMatchObject({ title: "Нова назва", category: "ELECTRICAL", description: null, priceEstimate: "123.45" });
    expect((await patch(a, row.id, { priceEstimate: null, isActive: false }).expect(200)).body.service).toMatchObject({ priceEstimate: null, isActive: false });
    expect((await patch(a, row.id, { isActive: true }).expect(200)).body.service.isActive).toBe(true);
    expect(await database.service.count({ where: { id: row.id } })).toBe(1);
  });
  test("profile update changes only city/category/description, not User or approval or service category", async () => {
    const owner = await account("profile-editor"); const beforeUser = await database.user.findUniqueOrThrow({ where: { id: owner.id } });
    const result = await call(owner, "patch", "/master/profile").send({ city: "  Нове   місто ", category: "PLUMBING", description: null }).expect(200);
    expect(result.body.profile).toMatchObject({ city: "Нове місто", category: "PLUMBING", description: null }); safe(result.body);
    expect(await database.user.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(beforeUser);
    expect((await database.masterProfile.findUniqueOrThrow({ where: { id: owner.profile.id } })).isApproved).toBe(owner.profile.isApproved);
    expect((await call(owner, "get", "/master/services")).body.services[0].category).toBe("TECH_REPAIR");
  });
  const invalid = [{ title: " " }, { title: "x".repeat(161) }, { category: "INVALID" }, { description: 1 }, { description: "x".repeat(2001) },
    { priceEstimate: "" }, { priceEstimate: -1 }, { priceEstimate: 0 }, { priceEstimate: "-0.01" }, { priceEstimate: "1.234" }, { priceEstimate: "100000000.00" },
    { priceEstimate: "NaN" }, { priceEstimate: "1e2" }, { isActive: "false" }, { masterProfileId: "spoof" }, { userId: "spoof" }, { id: randomUUID() }];
  test.each(invalid)("invalid service field %# returns field errors and creates nothing", async (change) => {
    const before = await database.service.count({ where: { masterProfileId: a.profile.id } });
    const result = await call(a, "post", "/master/services").send({ ...input, ...change }).expect(400);
    expect(result.body.error.fields).toBeDefined(); expect(await database.service.count({ where: { masterProfileId: a.profile.id } })).toBe(before);
  });
  test("PATCH rejects an empty body and forbidden fields without changing service", async () => {
    const row = await create(); const before = await database.service.findUniqueOrThrow({ where: { id: row.id } });
    for (const body of [{}, { isApproved: true }, { priceEstimate: "-1" }, { masterProfileId: b.profile.id }]) await patch(a, row.id, body).expect(400);
    expect(await database.service.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });
  test.each([{}, { city: " " }, { city: "x".repeat(101) }, { category: "INVALID" }, { description: 5 }, { description: "x".repeat(2001) },
    { isApproved: true }, { name: "Changed" }, { email: "spoof@fixit.test" }, { passwordHash: "spoof" }, { role: "ADMIN" }, { userId: randomUUID() }])("invalid/forbidden profile payload %# changes nothing", async (body) => {
    const before = await database.masterProfile.findUniqueOrThrow({ where: { id: a.profile.id } });
    await call(a, "patch", "/master/profile").send(body).expect(400); expect(await database.masterProfile.findUniqueOrThrow({ where: { id: a.profile.id } })).toEqual(before);
  });
  test("historic STANDARD snapshots survive service/profile changes and hiding", async () => {
    const owner = await account("history-owner"); const row = await create({ priceEstimate: "250.50" }, owner);
    const order = await commands.createStandard(client.id, { serviceId: row.id, masterProfileId: owner.profile.id, description: "Synthetic history fixture only" });
    await patch(owner, row.id, { title: "Changed title", category: "OTHER", priceEstimate: "9.99", description: "Changed", isActive: false }).expect(200);
    await call(owner, "patch", "/master/profile").send({ city: "Changed city", category: "ELECTRICAL" }).expect(200);
    expect(await database.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
  });
  test("profile changes affect future CUSTOM audience and direct response guard, not existing snapshots", async () => {
    const owner = await account("audience-owner"); const nextCity = `Changed ${city}`;
    const before = await commands.createCustom(client.id, { title: "Before", description: "Synthetic", city, category: "TECH_REPAIR" });
    const next = await commands.createCustom(client.id, { title: "After", description: "Synthetic", city: nextCity, category: "OTHER" });
    await call(owner, "patch", "/master/profile").send({ city: nextCity, category: "OTHER" }).expect(200);
    const feed = (await call(owner, "get", "/master/orders/available")).body.orders.map((r) => r.id);
    expect(feed).toContain(next.id); expect(feed).not.toContain(before.id);
    await call(owner, "post", `/master/orders/${before.id}/responses`).send({ message: "Wrong audience" }).expect(403);
    await call(owner, "post", `/master/orders/${next.id}/responses`).send({ message: "Correct audience" }).expect(201);
    expect(await database.order.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });
});
describe("anonymous public catalog, literal search and bounded pagination", () => {
  test("anonymous catalog is 200, bounded and contains only public fields", async () => {
    const result = (await catalog().expect(200)).body; expect(result.limit).toBe(12); expect(result.services.length).toBeLessThanOrEqual(12); safe(result);
    expect(result.services.every((s) => s.isActive)).toBe(true);
  });
  test("city + service category + normalized title/description query are combined server-side", async () => {
    const match = await create({ title: `${needle}   ремонт крана`, description: "унікальний опис", category: "PLUMBING" });
    await create({ title: `${needle} ремонт крана`, category: "ELECTRICAL" });
    await create({ title: `${needle} ремонт крана` }, b);
    const result = (await catalog({ city: city.toUpperCase(), category: "PLUMBING", q: `  ${needle}   ремонт крана  ` }).expect(200)).body;
    expect(result.services.map((s) => s.id)).toEqual([match.id]); expect(result.services[0].master.category).toBe("TECH_REPAIR");
    expect((await catalog({ city, q: "унікальний опис" })).body.services.map((s) => s.id)).toContain(match.id);
  });
  test("hidden service disappears from catalog/profile and reactivation restores it", async () => {
    const row = await create({ title: `${needle}-visibility` }); await patch(a, row.id, { isActive: false }).expect(200);
    expect((await catalog({ q: row.title })).body.services).toEqual([]);
    const hiddenProfile = (await publicProfile(a.profile.id, { limit: "50" }).expect(200)).body;
    expect(hiddenProfile.services.some((s) => s.id === row.id)).toBe(false); safe(hiddenProfile);
    await patch(a, row.id, { isActive: true }).expect(200);
    expect((await catalog({ q: row.title })).body.services.map((s) => s.id)).toEqual([row.id]);
  });
  test.each(["%", "_", "\\"])("search %s is literal, not a wildcard", async (special) => {
    const row = await create({ title: `${needle}-literal-${special}` }); await create({ title: `${needle}-literal-X` });
    const rows = (await catalog({ city, q: `${needle}-literal-${special}` }).expect(200)).body.services;
    expect(rows.map((s) => s.id)).toEqual([row.id]);
  });
  test("city wildcards are literal, and SQL-looking search remains harmless data", async () => {
    const owner = await account("wildcard-city", "MASTER", { city: "%" }); const row = await create({ title: `${needle}-wildcity` }, owner);
    expect((await catalog({ city: "%", q: needle }).expect(200)).body.services.map((s) => s.id)).toEqual([row.id]);
    expect((await catalog({ city, q: "%' OR 1=1 --" }).expect(200)).body.services).toEqual([]);
  });
  test("pages are bounded, stable/disjoint and total excludes hidden rows", async () => {
    const prefix = `${needle}-paging`;
    for (let i = 0; i < 6; i++) await create({ title: `${prefix}-${i}` }); await create({ title: `${prefix}-hidden`, isActive: false });
    const first = (await catalog({ q: prefix, limit: "2" }).expect(200)).body;
    const second = (await catalog({ q: prefix, limit: "2", page: "2" }).expect(200)).body;
    expect(first).toMatchObject({ total: 6, totalPages: 3, page: 1, limit: 2 }); expect(first.services).toHaveLength(2);
    expect(new Set([...first.services, ...second.services].map((s) => s.id)).size).toBe(4);
    expect((await catalog({ q: prefix, limit: "2" })).body).toEqual(first);
    expect((await catalog({ q: prefix, page: "10000" })).body.services).toEqual([]);
  });
  test("public master is keyed by profile UUID, with bounded active services and no private metadata", async () => {
    const result = (await publicProfile(a.profile.id, { limit: "1" }).expect(200)).body;
    expect(result.master).toMatchObject({ id: a.profile.id, name: a.name }); expect(result.services).toHaveLength(1); safe(result);
    await publicProfile(a.id).expect(404); await publicProfile("invalid").expect(400); await publicProfile(randomUUID()).expect(404);
  });
  test.each([{ category: "BAD" }, { city: " " }, { city: "x".repeat(101) }, { q: "x".repeat(121) }, { q: ["a", "b"] },
    { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "10001" }, { limit: "51" }, { limit: "0" }, { userId: "spoof" }, { isActive: "false" }])("invalid public query %# is 400", async (query) => {
    const result = await catalog(query).expect(400); expect(result.body.error.fields).toBeDefined();
  });
});
