import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { checkDatabase, createDatabaseClient } from "../dist/database/client.js";
import { issueToken } from "../dist/auth/token.js";
import { createOrderService } from "../dist/orders/service.js";
import { orderDetails, publicOrder, masterOrder, publicMasterSelect, safeTimeline } from "../dist/orders/dto.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900, corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 } };
const app = createApp(() => checkDatabase(database), options);
const commands = createOrderService(database);
const suffix = `@${randomUUID()}.details-api.fixit.test`;
const city = `Деталі ${randomUUID().slice(0, 8)}`;
let client, otherClient, master, otherMaster, admin, noProfile, service;
const custom = {}, standard = {};
async function account(name, role = "CLIENT") {
  const password = randomBytes(24).toString("hex");
  const result = await request(app).post("/api/v1/auth/register").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").send({ email: name + suffix, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "PLUMBING", profileDescription: "Synthetic profile", serviceTitle: "Synthetic STANDARD details service", serviceDescription: "Synthetic description", priceEstimate: "425.50" } : {}) }).expect(201);
  const user = result.body.user;
  return { ...user, token: issueToken(user.id, options), profile: await database.masterProfile.findUnique({ where: { userId: user.id } }) };
}
const call = (actor, path) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${actor.token}`);
const clientPath = (id) => `/orders/${id}`;
const masterPath = (id) => `/master/orders/${id}`;
const stored = (id) => database.order.findUniqueOrThrow({ where: { id }, include: { masterProfile: { select: publicMasterSelect } } });
async function fixture(type, status) {
  let order = type === "CUSTOM"
    ? await commands.createCustom(client.id, { title: "Synthetic CUSTOM details", description: "Synthetic problem", city, category: "PLUMBING", budget: "600.00" })
    : await commands.createStandard(client.id, { serviceId: service.id, description: "Synthetic STANDARD problem" });
  if (type === "CUSTOM" && !["OPEN", "CANCELLED"].includes(status)) {
    const offer = await commands.respond(master.id, { orderId: order.id, message: "Synthetic response", proposedPrice: "500.00" });
    order = await commands.selectResponse(client.id, { orderId: order.id, responseId: offer.id });
  } else if (type === "STANDARD" && !["PENDING", "CANCELLED"].includes(status)) {
    order = await commands.transition(master.id, { orderId: order.id, status: status === "DECLINED" ? "DECLINED" : "ACCEPTED" });
  }
  if (["IN_PROGRESS", "COMPLETED"].includes(status)) order = await commands.transition(master.id, { orderId: order.id, status: "IN_PROGRESS" });
  if (status === "COMPLETED") order = await commands.transition(master.id, { orderId: order.id, status: "COMPLETED" });
  if (status === "CANCELLED") order = await commands.transition(client.id, { orderId: order.id, status });
  return order;
}
beforeAll(async () => {
  await database.$connect();
  client = await account("client"); otherClient = await account("other-client");
  master = await account("master", "MASTER"); otherMaster = await account("other-master", "MASTER");
  service = await database.service.findFirstOrThrow({ where: { masterProfileId: master.profile.id } });
  for (const status of ["OPEN", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]) custom[status] = await fixture("CUSTOM", status);
  for (const status of ["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "DECLINED"]) standard[status] = await fixture("STANDARD", status);
  for (const [name, role] of [["admin", "ADMIN"], ["legacy-master", "MASTER"]]) {
    const user = await database.user.create({ data: { email: name + suffix, name: `Synthetic ${name}`, role, passwordHash: "synthetic-unused-hash" } });
    const actor = { ...user, token: issueToken(user.id, options) };
    if (role === "ADMIN") admin = actor; else noProfile = actor;
  }
});
afterAll(async () => {
  // Selected-response/history guards deliberately retain this cohort in *_test.
  // No deletion of unrelated data or assumption that only seed records exist.
  await database.$disconnect();
});

describe("scoped CLIENT / MASTER details reads", () => {
  test.each(["OPEN", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED"])("CLIENT reads own CUSTOM %s", async (status) => {
    const response = await call(client, clientPath(custom[status].id)).expect(200);
    expect(response.body.order).toMatchObject({ id: custom[status].id, type: "CUSTOM", status, budget: "600.00" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  test.each(["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "DECLINED"])("CLIENT reads own STANDARD %s", async (status) => {
    const response = await call(client, clientPath(standard[status].id)).expect(200);
    expect(response.body.order).toMatchObject({ id: standard[status].id, type: "STANDARD", status, budget: null, priceAtOrder: "425.50" });
  });
  test.each(["ACCEPTED", "IN_PROGRESS", "COMPLETED"])("assigned MASTER reads CUSTOM %s", async (status) => {
    const response = await call(master, masterPath(custom[status].id)).expect(200);
    expect(response.body.order).toMatchObject({ id: custom[status].id, type: "CUSTOM", status, assignedMaster: { id: master.profile.id, name: master.name } });
  });
  test.each(["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "DECLINED"])("assigned MASTER reads STANDARD %s", async (status) => {
    const response = await call(master, masterPath(standard[status].id)).expect(200);
    expect(response.body.order).toMatchObject({ id: standard[status].id, type: "STANDARD", status });
  });
  test.each(["CUSTOM", "STANDARD"])("foreign CLIENT cannot inspect %s", async (type) => {
    const id = type === "CUSTOM" ? custom.COMPLETED.id : standard.COMPLETED.id;
    const foreign = await call(otherClient, clientPath(id)).expect(404);
    const missing = await call(otherClient, clientPath(randomUUID())).expect(404);
    expect(foreign.body).toEqual(missing.body); expect(JSON.stringify(foreign.body)).not.toContain(id);
  });
  test.each(["CUSTOM", "STANDARD"])("foreign MASTER cannot inspect %s", async (type) => {
    const id = type === "CUSTOM" ? custom.COMPLETED.id : standard.PENDING.id;
    const foreign = await call(otherMaster, masterPath(id)).expect(404);
    expect(foreign.body).toEqual((await call(otherMaster, masterPath(randomUUID())).expect(404)).body);
  });
  test.each(["OPEN", "CANCELLED"])("MASTER cannot inspect unassigned CUSTOM %s", async (status) => {
    await call(master, masterPath(custom[status].id)).expect(404);
  });
  test("an offer alone never grants private detail access", async () => {
    await commands.respond(otherMaster.id, { orderId: custom.OPEN.id, message: "Synthetic unselected response" });
    await call(otherMaster, masterPath(custom.OPEN.id)).expect(404);
    const feed = await call(otherMaster, "/master/orders/available").expect(200);
    expect(feed.body.orders.some((order) => order.id === custom.OPEN.id)).toBe(true);
    expect(JSON.stringify(feed.body)).not.toMatch(/clientId|actorUserId|statusHistory|passwordHash|email/);
  });
  test("CLIENT scoped query includes JWT identity in the initial database read", async () => {
    const spy = jest.spyOn(database.order, "findFirst");
    try {
      await call(client, clientPath(standard.PENDING.id)).expect(200);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: standard.PENDING.id, clientId: client.id, client: { role: "CLIENT" } } }));
    } finally { spy.mockRestore(); }
  });
  test("MASTER scoped query includes profile ownership and current role", async () => {
    const spy = jest.spyOn(database.order, "findFirst");
    try {
      await call(master, masterPath(standard.PENDING.id)).expect(200);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: standard.PENDING.id, masterProfile: { userId: master.id, user: { role: "MASTER" } } } }));
    } finally { spy.mockRestore(); }
  });
  test("legacy MASTER without profile cannot inspect details", async () => { await call(noProfile, masterPath(standard.PENDING.id)).expect(404); });
});

describe.each(["CLIENT", "MASTER"])("%s details security boundary", (audience) => {
  const path = audience === "CLIENT" ? clientPath : masterPath;
  const owner = () => audience === "CLIENT" ? client : master;
  test("missing JWT is 401", async () => { await request(app).get(`/api/v1${path(randomUUID())}`).expect(401); });
  test.each(["invalid", "expired", "wrong-key", "deleted"])("%s JWT is 401", async (kind) => {
    const token = kind === "invalid" ? "invalid.token" : issueToken(kind === "deleted" ? randomUUID() : owner().id,
      { ...options, ...(kind === "expired" ? { tokenTtlSeconds: -10 } : kind === "wrong-key" ? { jwtSecret: randomBytes(48).toString("hex") } : {}) });
    await call({ token }, path(standard.PENDING.id)).expect(401);
  });
  test("wrong role is 403", async () => { await call(audience === "CLIENT" ? master : client, path(standard.PENDING.id)).expect(403); });
  test("internal ADMIN is 403", async () => { await call(admin, path(standard.PENDING.id)).expect(403); });
  test.each(["invalid", "1", "00000000-0000-0000-0000-00000000000g"])("invalid UUID %s is 400", async (id) => { await call(owner(), path(id)).expect(400); });
  test("unknown UUID is a safe 404", async () => {
    const result = await call(owner(), path(randomUUID())).expect(404);
    expect(JSON.stringify(result.body)).not.toMatch(/SELECT|stack|prisma|password|actorUserId/i);
  });
  test.each([{ clientId: "spoof" }, { masterProfileId: "spoof" }, { include: "client" }, { page: "1" }])("query override %# is 400", async (query) => {
    await call(owner(), path(standard.PENDING.id)).query(query).expect(400);
  });
});

describe("safe detail DTO, immutable snapshots and real DB timeline", () => {
  test("CLIENT reuses publicOrder fields but replaces raw audit history", async () => {
    const row = await stored(custom.COMPLETED.id); const { statusHistory, ...base } = publicOrder(row);
    const actual = (await call(client, clientPath(row.id)).expect(200)).body.order;
    expect(actual).toEqual({ ...JSON.parse(JSON.stringify(base)), timeline: safeTimeline(statusHistory) });
    expect(JSON.stringify(actual)).not.toMatch(/actorUserId|statusHistory|passwordHash|email|accessToken|isApproved/);
    expect(JSON.stringify(actual)).not.toContain(master.id);
  });
  test("MASTER extends masterOrder without client identity or raw actor IDs", async () => {
    const row = await stored(custom.COMPLETED.id); const actual = (await call(master, masterPath(row.id)).expect(200)).body.order;
    expect(actual).toMatchObject(JSON.parse(JSON.stringify(masterOrder(row))));
    expect(JSON.stringify(actual)).not.toMatch(/clientId|actorUserId|statusHistory|userId|passwordHash|email|accessToken|isApproved/);
    expect(JSON.stringify(actual)).not.toContain(client.id); expect(JSON.stringify(actual)).not.toContain(master.id);
    expect(actual.timeline).toEqual(safeTimeline(row.statusHistory));
  });
  test.each(["CUSTOM", "STANDARD"])("%s real events and completedAt match immutable trigger history", async (type) => {
    const id = (type === "CUSTOM" ? custom : standard).COMPLETED.id; const before = await stored(id);
    const response = await call(client, clientPath(id)).expect(200); const dto = response.body.order;
    expect(dto.timeline.map((event) => event.status)).toEqual([type === "CUSTOM" ? "OPEN" : "PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);
    expect(dto.timeline).toEqual(before.statusHistory.map(({ status, at, source }) => ({ status, at: new Date(at).toISOString(), source })));
    expect(dto.completedAt).toBe(new Date(before.statusHistory.at(-1).at).toISOString());
    expect((await call(client, clientPath(id)).expect(200)).body).toEqual(response.body);
    expect(await stored(id)).toEqual(before);
  });
  test("refresh returns current state after an existing transition", async () => {
    const order = await fixture("STANDARD", "PENDING");
    expect((await call(client, clientPath(order.id))).body.order.status).toBe("PENDING");
    await commands.transition(master.id, { orderId: order.id, status: "ACCEPTED" });
    const dto = (await call(client, clientPath(order.id)).expect(200)).body.order;
    expect(dto.status).toBe("ACCEPTED"); expect(dto.timeline.map((event) => event.status)).toEqual(["PENDING", "ACCEPTED"]);
  });
  test("service/profile edits do not rewrite historical detail fields", async () => {
    const before = (await call(client, clientPath(standard.COMPLETED.id))).body.order;
    await request(app).patch(`/api/v1/master/services/${service.id}`).set("Authorization", `Bearer ${master.token}`).send({ title: "Changed synthetic title", category: "OTHER", priceEstimate: "999.99" }).expect(200);
    await request(app).patch("/api/v1/master/profile").set("Authorization", `Bearer ${master.token}`).send({ city: "Інше синтетичне місто" }).expect(200);
    const after = (await call(client, clientPath(standard.COMPLETED.id))).body.order;
    for (const key of ["title", "city", "category", "priceAtOrder", "createdAt", "updatedAt", "timeline"]) expect(after[key]).toEqual(before[key]);
    expect(after.assignedMaster.city).not.toBe(before.city);
  });
  test("null estimate remains null in both detail DTOs", async () => {
    const svc = await database.service.create({ data: { masterProfileId: master.profile.id, title: "Synthetic nullable estimate", category: "OTHER", description: null, priceEstimate: null } });
    const order = await commands.createStandard(client.id, { serviceId: svc.id, description: "Synthetic no estimate" });
    for (const [actor, path] of [[client, clientPath], [master, masterPath]]) expect((await call(actor, path(order.id)).expect(200)).body.order.priceAtOrder).toBeNull();
  });
  test("CLIENT can still read its own CUSTOM responses through the existing endpoint", async () => {
    const response = await call(client, `/orders/${custom.COMPLETED.id}/responses`).expect(200);
    expect(response.body.responses).toHaveLength(1); expect(response.body.responses[0].master.id).toBe(master.profile.id);
  });
  test("assigned CUSTOM cancellation stays visible to both participants", async () => {
    // Earlier test changed the master city; use its current, authoritative city.
    const profile = await database.masterProfile.findUniqueOrThrow({ where: { userId: master.id } });
    const order = await commands.createCustom(client.id, { title: "Synthetic accepted cancellation", description: "Synthetic", city: profile.city, category: profile.category });
    const offer = await commands.respond(master.id, { orderId: order.id, message: "Synthetic proposal" });
    await commands.selectResponse(client.id, { orderId: order.id, responseId: offer.id });
    await commands.transition(client.id, { orderId: order.id, status: "CANCELLED" });
    for (const [actor, path] of [[client, clientPath], [master, masterPath]]) {
      const dto = (await call(actor, path(order.id)).expect(200)).body.order;
      expect(dto.status).toBe("CANCELLED"); expect(dto.timeline.map((event) => event.status)).toEqual(["OPEN", "ACCEPTED", "CANCELLED"]);
    }
    expect(await database.order.count({ where: { id: order.id } })).toBe(1);
  });
});

describe("timeline normalization for legacy/incomplete JSON (unit, no history writes)", () => {
  test.each([null, undefined, {}, "legacy", 5, [null, false, "legacy", [], {}, { status: "NEW", at: "2026-11-15T10:00:00Z" }]])("malformed history %# does not fabricate events", (history) => { expect(safeTimeline(history)).toEqual([]); });
  test("whitelist removes raw identities, arbitrary sources and legacy metadata", () => {
    expect(safeTimeline([{ status: "OPEN", at: "2026-11-15T12:00:00+02:00", actorUserId: "private", actorRole: "ADMIN", source: "private-source", email: "private@fixit.test", legacyCreatedAt: "invented" }]))
      .toEqual([{ status: "OPEN", at: "2026-11-15T10:00:00.000Z" }]);
  });
  test.each([undefined, null, 0, "invalid", "2026-02-30T10:00:00Z", "2026-11-15T10:00:00"])("unknown/invalid/ambiguous time %# is explicit null", (at) => {
    expect(safeTimeline([{ status: "PENDING", at, source: "legacy_migration" }])).toEqual([{ status: "PENDING", at: null, source: "legacy_migration" }]);
  });
  test("dated events sort chronologically, equal timestamps stay stable, undated remain explicit", () => {
    expect(safeTimeline([{ status: "COMPLETED", at: "2026-11-15T12:00:00Z", source: "database" }, { status: "PENDING" },
      { status: "ACCEPTED", at: "2026-11-15T10:00:00Z" }, { status: "IN_PROGRESS", at: "2026-11-15T10:00:00Z" }]).map((event) => event.status))
      .toEqual(["ACCEPTED", "IN_PROGRESS", "COMPLETED", "PENDING"]);
  });
  test("legacy migration observation is labelled and never asserted as real completion time", async () => {
    const row = await stored(standard.COMPLETED.id);
    const legacy = { ...row, statusHistory: [{ status: "COMPLETED", at: "2026-11-15T12:00:00Z", source: "legacy_migration", legacyCreatedAt: "2020-01-01T00:00:00Z" }] };
    for (const audience of ["CLIENT", "MASTER"]) {
      const dto = orderDetails(legacy, audience); expect(dto.completedAt).toBeNull();
      expect(dto.timeline).toEqual([{ status: "COMPLETED", at: "2026-11-15T12:00:00.000Z", source: "legacy_migration" }]);
    }
    expect(await stored(row.id)).toEqual(row);
  });
  test.each(["2026", "2026-02-30T12:00:00Z", "2026-11-15T12:00:00", "invalid"])("ambiguous/invalid completion timestamp %s is not invented", async (at) => {
    const row = await stored(standard.COMPLETED.id);
    const dto = orderDetails({ ...row, statusHistory: [{ status: "COMPLETED", at, source: "database" }] }, "CLIENT");
    expect(dto.completedAt).toBeNull(); expect(dto.timeline).toEqual([{ status: "COMPLETED", at: null, source: "database" }]);
  });
});
