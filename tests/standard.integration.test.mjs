import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { checkDatabase, createDatabaseClient } from "../dist/database/client.js";
import { issueToken } from "../dist/auth/token.js";
import { createOrderService } from "../dist/orders/service.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900, corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 } };
const app = createApp(() => checkDatabase(database), options);
const suffix = `@${randomUUID()}.standard-api.fixit.test`; const accountIds = []; const city = `Місто ${randomUUID().slice(0, 8)}`;
let client, otherClient, master, otherMaster;
async function account(name, role = "CLIENT") {
  const password = randomBytes(24).toString("hex");
  const result = await request(app).post("/api/v1/auth/register").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").send({ email: name + suffix, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "TECH_REPAIR", profileDescription: "Synthetic profile", serviceTitle: "Synthetic initial service", serviceDescription: "Synthetic initial description" } : {}) }).expect(201);
  const user = result.body.user; accountIds.push(user.id);
  return { ...user, token: issueToken(user.id, options), profile: await database.masterProfile.findUnique({ where: { userId: user.id } }) };
}
const call = (actor, method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${actor.token}`);
const createService = async (body = {}, owner = master) => (await call(owner, "post", "/master/services").send({ title: "Synthetic STANDARD service", category: "PLUMBING", description: "Synthetic description", priceEstimate: "250.50", ...body }).expect(201)).body.service;
const place = (id, change = {}, actor = client) => call(actor, "post", "/orders/standard").send({ serviceId: id, description: "Synthetic problem; district only", ...change });
const preview = (id, actor = client) => call(actor, "get", `/orders/standard/${id}`);
const transition = (id, status, actor = master) => call(actor, "patch", `/master/orders/${id}/status`).send({ status });
const stored = (id) => database.order.findUniqueOrThrow({ where: { id } });
const count = (id) => database.order.count({ where: { serviceId: id } });
const safeMaster = (data) => expect(JSON.stringify(data)).not.toMatch(/email|passwordHash|userId|actorUserId|statusHistory|isApproved|accessToken|clientId/i);
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function waitBlocked(pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const [row] = await database.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${pid}::int=ANY(pg_blocking_pids(a.pid))) AS blocked`;
    if (row.blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Expected a real PostgreSQL lock waiter");
}
beforeAll(async () => { await database.$connect(); client = await account("client"); otherClient = await account("other-client"); master = await account("master", "MASTER"); otherMaster = await account("other-master", "MASTER"); });
afterAll(async () => {
  const owners = { id: { in: accountIds } };
  await database.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { client: owners } });
    await tx.service.deleteMany({ where: { masterProfile: { user: owners } } }); await tx.masterProfile.deleteMany({ where: { user: owners } }); await tx.user.deleteMany({ where: owners });
  }); await database.$disconnect();
});
describe("STANDARD boundary and authoritative snapshots", () => {
  test.each(["get", "post"])("%s requires a JWT", async (method) => {
    const path = method === "get" ? `/orders/standard/${randomUUID()}` : "/orders/standard";
    await request(app)[method](`/api/v1${path}`).send(method === "post" ? {} : undefined).expect(401);
  });
  test.each(["get", "post"])("MASTER cannot %s CLIENT STANDARD even with invalid body", async (method) => {
    const path = method === "get" ? `/orders/standard/${randomUUID()}` : "/orders/standard"; await call(master, method, path).send(method === "post" ? {} : undefined).expect(403);
  });
  test.each(["invalid", "expired", "wrong-key", "deleted"])("%s JWT cannot create orders", async (kind) => {
    const token = kind === "invalid" ? "invalid.token" : issueToken(kind === "deleted" ? randomUUID() : client.id, { ...options, ...(kind === "expired" ? { tokenTtlSeconds: -10 } : kind === "wrong-key" ? { jwtSecret: randomBytes(48).toString("hex") } : {}) });
    const svc = await createService(); await place(svc.id, {}, { token }).expect(401); expect(await count(svc.id)).toBe(0);
  });
  test("ADMIN cannot place STANDARD", async () => {
    const admin = await database.user.create({ data: { email: "admin" + suffix, name: "Synthetic admin", role: "ADMIN", passwordHash: "synthetic-unused-hash" } }); accountIds.push(admin.id);
    await place(randomUUID(), {}, { token: issueToken(admin.id, options) }).expect(403);
  });
  test("preview exposes current public data/snapshot without User or Order metadata", async () => {
    const svc = await createService(); const data = (await preview(svc.id).expect(200)).body;
    expect(data.service).toMatchObject({ id: svc.id, title: svc.title, category: "PLUMBING", priceEstimate: "250.50", master: { id: master.profile.id, name: master.name, city } });
    expect(data.snapshot).toMatch(/^[0-9a-f]{64}$/); safeMaster(data);
  });
  test("201 derives owner/client/type/status and all snapshots exclusively on server", async () => {
    const svc = await createService(); const data = (await preview(svc.id)).body;
    const result = (await place(svc.id, { expectedSnapshot: data.snapshot, description: "  Synthetic district problem  " }).expect(201)).body.order;
    expect(result).toMatchObject({ clientId: client.id, serviceId: svc.id, masterProfileId: master.profile.id, type: "STANDARD", status: "PENDING", title: svc.title, category: svc.category, city, description: "Synthetic district problem", priceAtOrder: "250.50", budget: null, assignedMaster: { id: master.profile.id, name: master.name } });
    const row = await stored(result.id); expect(row.statusHistory).toEqual([expect.objectContaining({ status: "PENDING", source: "database", actorUserId: client.id })]);
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|"email"/);
    expect((await call(client, "get", "/orders")).body.orders.some((r) => r.id === row.id)).toBe(true);
    expect((await call(master, "get", "/master/orders/assigned")).body.orders.find((r) => r.id === row.id)).toMatchObject({ type: "STANDARD", status: "PENDING", serviceId: svc.id, priceAtOrder: "250.50" });
    expect((await call(otherMaster, "get", "/master/orders/assigned")).body.orders.some((r) => r.id === row.id)).toBe(false);
    expect((await call(otherClient, "get", "/orders")).body.orders.some((r) => r.id === row.id)).toBe(false);
  });
  test("CLIENT may choose another master's public service, never supply an executor ID", async () => {
    const svc = await createService({}, otherMaster);
    expect((await place(svc.id).expect(201)).body.order.masterProfileId).toBe(otherMaster.profile.id);
    await place(svc.id, { masterProfileId: master.profile.id }).expect(400); expect(await count(svc.id)).toBe(1);
  });
  test.each([[null, null], ["0", "0.00"], ["99999999.99", "99999999.99"]])("snapshot price %s retains null/exact decimal semantics", async (priceEstimate, expected) => {
    const svc = await createService({ priceEstimate }); const row = (await place(svc.id).expect(201)).body.order;
    expect(row.priceAtOrder).toBe(expected); expect((await stored(row.id)).priceAtOrder?.toFixed(2) ?? null).toBe(expected);
  });
  test("inactive preview is 404 and POST is 409 without any Order", async () => {
    const svc = await createService({ isActive: false }); await preview(svc.id).expect(404); await place(svc.id).expect(409); expect(await count(svc.id)).toBe(0);
  });
  test("missing/invalid Service IDs are 404/400 without a write", async () => {
    await preview(randomUUID()).expect(404); await place(randomUUID()).expect(404); await preview("invalid").expect(400); await place("invalid").expect(400);
  });
  test.each([{ serviceId: undefined }, { description: undefined }, { description: " " }, { description: "x".repeat(4001) }, { description: null }, { description: 1 },
    { clientId: randomUUID() }, { masterProfileId: randomUUID() }, { userId: randomUUID() }, { status: "ACCEPTED" }, { priceAtOrder: "0.01" }, { title: "Forged" }, { city: "Forged" }, { category: "OTHER" }, { type: "CUSTOM" }, { role: "CLIENT" }, { expectedSnapshot: "invalid" }])("invalid/spoofed body %# is 400 with no partial row", async (change) => {
    const svc = await createService(); const result = await place(svc.id, change).expect(400); expect(result.body.error.fields).toBeDefined(); expect(await count(svc.id)).toBe(0);
  });
  test("empty body and query identity overrides are rejected", async () => {
    await call(client, "post", "/orders/standard").send({}).expect(400);
    const svc = await createService(); await place(svc.id).query({ clientId: otherClient.id }).expect(400); await preview(svc.id).query({ masterProfileId: otherMaster.profile.id }).expect(400); expect(await count(svc.id)).toBe(0);
  });
  test.each(["title", "category", "priceEstimate", "city"])("changed preview %s requires 409 and fresh confirmation", async (field) => {
    const owner = await account(randomUUID(), "MASTER"); const svc = await createService({}, owner); const before = (await preview(svc.id)).body;
    if (field === "city") await call(owner, "patch", "/master/profile").send({ city: `Changed ${city}` }).expect(200);
    else await call(owner, "patch", `/master/services/${svc.id}`).send({ [field]: field === "title" ? "New title" : field === "category" ? "OTHER" : "900.99" }).expect(200);
    await place(svc.id, { expectedSnapshot: before.snapshot }).expect(409); expect(await count(svc.id)).toBe(0);
    const fresh = (await preview(svc.id)).body; expect(fresh.snapshot).not.toBe(before.snapshot);
    const row = (await place(svc.id, { expectedSnapshot: fresh.snapshot }).expect(201)).body.order;
    expect(row).toMatchObject({ title: fresh.service.title, category: fresh.service.category, city: fresh.service.master.city, priceAtOrder: fresh.service.priceEstimate });
  });
  test("snapshot from another service cannot pin an arbitrary owner or price", async () => {
    const a = await createService(), b = await createService({}, otherMaster); const data = (await preview(b.id)).body;
    await place(a.id, { expectedSnapshot: data.snapshot }).expect(409); expect(await count(a.id)).toBe(0);
  });
  test("later service/profile edits and hiding cannot rewrite historical Order snapshots", async () => {
    const owner = await account("snapshot-owner", "MASTER"); const svc = await createService({}, owner); const row = (await place(svc.id).expect(201)).body.order; const before = await stored(row.id);
    await call(owner, "patch", `/master/services/${svc.id}`).send({ title: "Changed", category: "OTHER", priceEstimate: null, isActive: false }).expect(200);
    await call(owner, "patch", "/master/profile").send({ city: `Changed ${city}`, category: "OTHER" }).expect(200);
    expect(await stored(row.id)).toEqual(before);
    expect((await call(owner, "get", "/master/orders/assigned")).body.orders.find((r) => r.id === row.id)).toMatchObject({ title: svc.title, priceAtOrder: "250.50", status: "PENDING" });
  });
});
describe("real concurrent create/hide/edit operations", () => {
  test.each(["hide", "edit"])("a concurrent atomic %s commits before creation: latest coherent data or 409", async (kind) => {
    const owner = await account(randomUUID(), "MASTER"); const svc = await createService({}, owner); const ready = gate(), release = gate();
    const writer = database.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM master_profiles WHERE id=${owner.profile.id}::uuid FOR UPDATE`;
      if (kind === "hide") await tx.service.update({ where: { id: svc.id }, data: { isActive: false } });
      else { await tx.masterProfile.update({ where: { id: owner.profile.id }, data: { city: "Atomic new city" } }); await tx.service.update({ where: { id: svc.id }, data: { title: "Atomic new title", category: "OTHER", priceEstimate: "876.54" } }); }
      ready.resolve(pid); await release.promise;
    }, { timeout: 15000 });
    let placing;
    try {
      const pid = await ready.promise; placing = place(svc.id).then((result) => result); await waitBlocked(pid);
      release.resolve(); await writer; const result = await placing;
      if (kind === "hide") { expect(result.status).toBe(409); expect(await count(svc.id)).toBe(0); }
      else { expect(result.status).toBe(201); expect(result.body.order).toMatchObject({ city: "Atomic new city", title: "Atomic new title", category: "OTHER", priceAtOrder: "876.54" }); }
    } finally { release.resolve(); await Promise.allSettled([writer, placing]); }
  });
  test.each(["profile", "service"])("creation holds %s snapshot locks until commit; following edit cannot rewrite it", async (target) => {
    const owner = await account(randomUUID(), "MASTER"); const svc = await createService({}, owner); const ready = gate(), release = gate();
    const paused = createOrderService({ $transaction: (callback) => database.$transaction(async (tx) => {
      const row = await callback(tx); const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`; ready.resolve(pid); await release.promise; return row;
    }, { timeout: 15000 }) });
    const creating = paused.createStandard(client.id, { serviceId: svc.id, description: "Synthetic paused snapshot" }); let editing;
    try {
      const pid = await ready.promise;
      editing = (target === "profile" ? call(owner, "patch", "/master/profile").send({ city: "Later city" }) : call(owner, "patch", `/master/services/${svc.id}`).send({ title: "Later title", priceEstimate: "1.00", isActive: false })).then((result) => result);
      await waitBlocked(pid); release.resolve(); const row = await creating; expect((await editing).status).toBe(200);
      expect(row).toMatchObject({ title: svc.title, city, category: svc.category }); expect(row.priceAtOrder.toFixed(2)).toBe("250.50"); expect(await stored(row.id)).toEqual(row);
    } finally { release.resolve(); await Promise.allSettled([creating, editing]); }
  });
});
describe("STANDARD lifecycle and shared history", () => {
  test("accept → start → complete uses the existing transition/history triggers", async () => {
    const svc = await createService(); const order = (await place(svc.id).expect(201)).body.order;
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"]) { const row = (await transition(order.id, status).expect(200)).body.order; expect(row.status).toBe(status); safeMaster(row); }
    const row = await stored(order.id); expect(row.statusHistory.map((e) => e.status)).toEqual(["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);
    expect(row.statusHistory.slice(1).every((e) => e.actorUserId === master.id && e.source === "database")).toBe(true);
    const history = (await call(client, "get", "/orders")).body.orders.find((r) => r.id === row.id); expect(history.completedAt).toBe(new Date(row.statusHistory.at(-1).at).toISOString());
    await call(client, "delete", `/orders/${row.id}`).expect(409); await transition(row.id, "COMPLETED").expect(409); expect(await stored(row.id)).toEqual(row);
  });
  test("DECLINED is terminal and remains in both histories", async () => {
    const row = (await place((await createService()).id).expect(201)).body.order; await transition(row.id, "DECLINED").expect(200);
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED", "DECLINED"]) await transition(row.id, status).expect(409);
    await call(client, "delete", `/orders/${row.id}`).expect(409);
    expect((await stored(row.id)).statusHistory.map((e) => e.status)).toEqual(["PENDING", "DECLINED"]);
    expect((await call(client, "get", "/orders")).body.orders.find((r) => r.id === row.id).status).toBe("DECLINED");
    expect((await call(master, "get", "/master/orders/assigned")).body.orders.find((r) => r.id === row.id).status).toBe("DECLINED");
  });
  test.each(["PENDING", "ACCEPTED"])("CLIENT cancels %s logically once", async (status) => {
    const row = (await place((await createService()).id).expect(201)).body.order; if (status === "ACCEPTED") await transition(row.id, "ACCEPTED").expect(200);
    await call(client, "delete", `/orders/${row.id}`).expect(200); const after = await stored(row.id); expect(after.status).toBe("CANCELLED");
    await call(client, "delete", `/orders/${row.id}`).expect(409); await transition(row.id, "ACCEPTED").expect(409); expect(await stored(row.id)).toEqual(after);
  });
  test("wrong MASTER/CLIENT cannot mutate incoming STANDARD", async () => {
    const row = (await place((await createService()).id).expect(201)).body.order;
    await transition(row.id, "ACCEPTED", otherMaster).expect(403); await transition(row.id, "ACCEPTED", client).expect(403); await call(otherClient, "delete", `/orders/${row.id}`).expect(403);
    await transition(row.id, "IN_PROGRESS").expect(409); expect((await stored(row.id)).statusHistory).toHaveLength(1);
  });
  test("competing accept/decline requests commit exactly one transition", async () => {
    const row = (await place((await createService()).id).expect(201)).body.order;
    const results = await Promise.all([transition(row.id, "ACCEPTED"), transition(row.id, "DECLINED")]); expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await stored(row.id); expect(current.statusHistory).toHaveLength(2); expect(current.statusHistory.at(-1).status).toBe(current.status);
  });
  test("CUSTOM and STANDARD coexist in the same CLIENT history", async () => {
    const standard = (await place((await createService()).id).expect(201)).body.order;
    const custom = (await call(client, "post", "/orders").send({ title: "Synthetic CUSTOM regression", city, category: "OTHER", description: "Synthetic" }).expect(201)).body.order;
    const rows = (await call(client, "get", "/orders")).body.orders;
    expect(rows.find((r) => r.id === standard.id).type).toBe("STANDARD"); expect(rows.find((r) => r.id === custom.id).type).toBe("CUSTOM");
  });
});
