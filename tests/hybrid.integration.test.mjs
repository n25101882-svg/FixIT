import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, test } from "@jest/globals";
import { createDatabaseClient } from "../dist/database/client.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { seedDatabase, seedIds as ids } from "../dist/database/seed.js";
import { createOrderService } from "../dist/orders/service.js";

const database = createDatabaseClient(
  requireLocalTestDatabase(process.env.TEST_DATABASE_URL),
);
const commands = createOrderService(database);
const customInput = {
  title: "Синтетична проблема",
  city: "Тестоград",
  category: "OTHER",
  description: "Synthetic test data only",
};
const standardInput = {
  serviceId: ids.serviceA,
  masterProfileId: ids.profileA,
  description: "Synthetic standard request",
};
beforeAll(async () => {
  await database.$connect();
  await seedDatabase(database);
});
afterAll(async () => {
  await database.$disconnect();
});

async function rollback(action) {
  const abort = new Error("rollback test");
  try {
    await database.$transaction(async (tx) => {
      await action(tx);
      throw abort;
    });
  } catch (error) {
    if (error !== abort) throw error;
  }
}
async function withCommands(action) {
  return rollback(async (tx) => {
    // Eligibility is now checked by respond(); align only this rolled-back fixture.
    await tx.masterProfile.updateMany({ where: { id: { in: [ids.profileA, ids.profileB] } },
      data: { city: customInput.city, category: customInput.category } });
    return action(
      createOrderService({ $transaction: (callback) => callback(tx) }),
      tx,
    );
  });
}
const rejects = (action, code) =>
  expect(Promise.resolve().then(action)).rejects.toMatchObject({ code });

describe("Hybrid persistence invariants", () => {
  test("all four ordered migrations are applied", async () => {
    const rows =
      await database.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    expect(rows.map((r) => r.migration_name)).toEqual([
      "20261109200000_init_database_schema",
      "20261114130000_hybrid_mvp",
      "20261114150000_review_snapshot_alignment",
      "20261116090000_add_auth_sessions",
    ]);
  });
  test("seed has STANDARD and unassigned OPEN CUSTOM with unique proposals", async () => {
    const order = await database.order.findUniqueOrThrow({
      where: { id: ids.customOrder },
      include: { responses: true },
    });
    expect(order.type).toBe("CUSTOM");
    expect(order.status).toBe("OPEN");
    expect(order.serviceId).toBeNull();
    expect(order.masterProfileId).toBeNull();
    expect(order.priceAtOrder).toBeNull();
    expect(order.responses).toHaveLength(2);
    expect(new Set(order.responses.map((r) => r.masterProfileId)).size).toBe(2);
  });
  test("STANDARD master must own the selected service (composite FK)", async () => {
    await expect(
      rollback((tx) =>
        tx.order.create({
          data: {
            ...customInput,
            type: "STANDARD",
            status: "PENDING",
            clientId: ids.clientA,
            serviceId: ids.serviceA,
            masterProfileId: ids.profileB,
            priceAtOrder: "1.00",
          },
        }),
      ),
    ).rejects.toThrow();
  });
  test.each([
    {
      type: "STANDARD",
      status: "OPEN",
      serviceId: ids.serviceA,
      masterProfileId: ids.profileA,
      priceAtOrder: "1.00",
    },
    {
      type: "STANDARD",
      status: "PENDING",
      serviceId: null,
      masterProfileId: ids.profileA,
      priceAtOrder: "1.00",
    },
    { type: "CUSTOM", status: "PENDING" },
    { type: "CUSTOM", status: "OPEN", serviceId: ids.serviceA },
    { type: "CUSTOM", status: "OPEN", masterProfileId: ids.profileA },
  ])("rejects invalid initial order shape (%#)", async (data) => {
    await expect(
      rollback((tx) =>
        tx.order.create({
          data: { ...customInput, clientId: ids.clientA, ...data },
        }),
      ),
    ).rejects.toThrow();
  });
  test("one profile can submit only one proposal for an order", async () => {
    await expect(
      rollback((tx) =>
        tx.orderResponse.create({
          data: {
            orderId: ids.customOrder,
            masterProfileId: ids.profileA,
            proposedPrice: "10.00",
            message: "duplicate",
          },
        }),
      ),
    ).rejects.toThrow();
  });
  test("proposals cannot target STANDARD or absent orders/profiles", async () => {
    for (const data of [
      { orderId: ids.orderA, masterProfileId: ids.profileB },
      { orderId: randomUUID(), masterProfileId: ids.profileB },
      { orderId: ids.customOrder, masterProfileId: randomUUID() },
    ])
      await expect(
        rollback((tx) =>
          tx.orderResponse.create({
            data: { ...data, proposedPrice: "0.01", message: "Synthetic" },
          }),
        ),
      ).rejects.toThrow();
  });
  test.each(["-0.01", "100000000.00", "NaN"])(
    "rejects invalid decimal price %s",
    async (price) => {
      await expect(
        rollback((tx) =>
          tx.service.update({ where: { id: ids.serviceA }, data: { priceEstimate: price } }),
        ),
      ).rejects.toThrow();
      await expect(
        rollback((tx) =>
          tx.order.create({
            data: {
              ...customInput,
              clientId: ids.clientA,
              type: "STANDARD",
              status: "PENDING",
              serviceId: ids.serviceA,
              masterProfileId: ids.profileA,
              priceAtOrder: price,
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        rollback(async (tx) => {
          const order = await tx.order.create({
            data: {
              ...customInput,
              clientId: ids.clientA,
              type: "CUSTOM",
              status: "OPEN",
            },
          });
          await tx.orderResponse.create({
            data: {
              orderId: order.id,
              masterProfileId: ids.profileA,
              proposedPrice: price,
              message: "Synthetic",
            },
          });
        }),
      ).rejects.toThrow();
    },
  );
  test("zero and upper-bound prices are exact decimals", async () => {
    await rollback(async (tx) => {
      await tx.service.update({
        where: { id: ids.serviceA },
        data: { priceEstimate: "99999999.99" },
      });
      expect(
        (
          await tx.service.findUniqueOrThrow({ where: { id: ids.serviceA } })
        ).priceEstimate.toFixed(2),
      ).toBe("99999999.99");
      await tx.service.update({
        where: { id: ids.serviceA },
        data: { priceEstimate: "0.00" },
      });
      expect(
        (
          await tx.service.findUniqueOrThrow({ where: { id: ids.serviceA } })
        ).priceEstimate.toFixed(2),
      ).toBe("0.00");
    });
  });
  test("cannot skip statuses, rewrite history, reassign STANDARD master or prices", async () => {
    for (const data of [
      { status: "COMPLETED" },
      { statusHistory: [] },
      { priceAtOrder: "1.00" },
      { masterProfileId: ids.profileB },
    ]) {
      await expect(
        rollback((tx) => tx.order.update({ where: { id: ids.orderA }, data })),
      ).rejects.toThrow();
    }
  });
  test("proposals are immutable", async () => {
    await expect(
      rollback((tx) =>
        tx.orderResponse.update({
          where: { id: ids.responseA },
          data: { proposedPrice: "1.00" },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("server commands (trusted actor boundary, no Auth imported)", () => {
  test("creates STANDARD PENDING with service/master/location and a price snapshot", async () => {
    await withCommands(async (service, tx) => {
      const order = await service.createStandard(ids.clientA, standardInput);
      expect(order.status).toBe("PENDING");
      expect(order.type).toBe("STANDARD");
      expect(order.masterProfileId).toBe(ids.profileA);
      expect(order.priceAtOrder.toFixed(2)).toBe("250.00");
      expect(order.statusHistory[0].actorUserId).toBe(ids.clientA);
      await tx.service.update({
        where: { id: ids.serviceA },
        data: { priceEstimate: "999.00" },
      });
      expect(
        (
          await tx.order.findUniqueOrThrow({ where: { id: order.id } })
        ).priceAtOrder.toFixed(2),
      ).toBe("250.00");
    });
  });
  test("rejects inactive services, mismatched masters and non-CLIENT actors", async () => {
    await rejects(
      () => commands.createStandard(ids.masterA, standardInput),
      "FORBIDDEN",
    );
    await rejects(
      () => commands.createStandard(ids.admin, standardInput),
      "FORBIDDEN",
    );
    await rejects(
      () =>
        commands.createStandard(ids.clientA, {
          ...standardInput,
          masterProfileId: ids.profileB,
        }),
      "INVALID_INPUT",
    );
    await rejects(
      () =>
        commands.createStandard(ids.clientA, {
          ...standardInput,
          serviceId: ids.serviceB,
        }),
      "INVALID_INPUT",
    );
  });
  test("CUSTOM requires problem metadata and starts OPEN without an executor", async () => {
    await withCommands(async (service) => {
      const order = await service.createCustom(ids.clientA, customInput);
      expect([
        order.status,
        order.type,
        order.serviceId,
        order.masterProfileId,
        order.priceAtOrder,
      ]).toEqual(["OPEN", "CUSTOM", null, null, null]);
    });
    await rejects(
      () => commands.createCustom(ids.clientA, { ...customInput, city: " " }),
      "INVALID_INPUT",
    );
    await rejects(
      () =>
        commands.createCustom(ids.clientA, {
          ...customInput,
          category: "UNKNOWN",
        }),
      "INVALID_INPUT",
    );
  });
  test("only MASTER with own profile responds, once, with exact two-decimal input", async () => {
    await withCommands(async (service) => {
      const order = await service.createCustom(ids.clientA, customInput);
      const response = await service.respond(ids.masterA, {
        orderId: order.id,
        proposedPrice: "12.34",
        message: "Synthetic offer",
      });
      expect(response.masterProfileId).toBe(ids.profileA);
      expect(response.proposedPrice.toFixed(2)).toBe("12.34");
      await rejects(
        () =>
          service.respond(ids.masterA, {
            orderId: order.id,
            proposedPrice: "12.34",
            message: "again",
          }),
        "CONFLICT",
      );
      await rejects(
        () =>
          service.respond(ids.clientA, {
            orderId: order.id,
            proposedPrice: "12.34",
            message: "wrong role",
          }),
        "FORBIDDEN",
      );
    });
    await rejects(
      () =>
        commands.respond(ids.masterA, {
          orderId: ids.customOrder,
          proposedPrice: "1.001",
          message: "No rounding allowed",
        }),
      "INVALID_INPUT",
    );
  });
  test("only the order owner chooses an offer belonging to that request", async () => {
    await withCommands(async (service) => {
      const order = await service.createCustom(ids.clientA, customInput);
      await rejects(
        () =>
          service.selectResponse(ids.clientB, {
            orderId: order.id,
            responseId: ids.responseA,
          }),
        "FORBIDDEN",
      );
      await rejects(
        () =>
          service.selectResponse(ids.clientA, {
            orderId: order.id,
            responseId: ids.responseA,
          }),
        "NOT_FOUND",
      );
    });
  });
  test("enforces ownership, full legal progress and terminal states", async () => {
    await withCommands(async (service) => {
      const order = await service.createStandard(ids.clientA, standardInput);
      await rejects(
        () =>
          service.transition(ids.masterB, {
            orderId: order.id,
            status: "ACCEPTED",
          }),
        "FORBIDDEN",
      );
      await rejects(
        () =>
          service.transition(ids.clientA, {
            orderId: order.id,
            status: "ACCEPTED",
          }),
        "CONFLICT",
      );
      for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"])
        await service.transition(ids.masterA, { orderId: order.id, status });
      await rejects(
        () =>
          service.transition(ids.masterA, {
            orderId: order.id,
            status: "CANCELLED",
          }),
        "CONFLICT",
      );
    });
  });
  test("client cancels own OPEN/PENDING; master declines only PENDING STANDARD", async () => {
    await withCommands(async (service) => {
      const custom = await service.createCustom(ids.clientA, customInput);
      expect(
        (
          await service.transition(ids.clientA, {
            orderId: custom.id,
            status: "CANCELLED",
          })
        ).status,
      ).toBe("CANCELLED");
      await rejects(
        () =>
          service.respond(ids.masterA, {
            orderId: custom.id,
            proposedPrice: "1.00",
            message: "closed",
          }),
        "CONFLICT",
      );
      const standard = await service.createStandard(ids.clientA, standardInput);
      expect(
        (
          await service.transition(ids.masterA, {
            orderId: standard.id,
            status: "DECLINED",
          })
        ).status,
      ).toBe("DECLINED");
    });
  });
  test("concurrent selections commit exactly one executor and one history event", async () => {
    // This test intentionally commits one synthetic history to exercise two real
    // connections/transactions. It stays only in the isolated *_test database.
    const originalB = await database.masterProfile.findUniqueOrThrow({ where: { id: ids.profileB } });
    try {
      await database.masterProfile.update({ where: { id: ids.profileB }, data: { city: "Тестоград", category: "PLUMBING" } });
      const order = await commands.createCustom(ids.clientA, {
        ...customInput,
        category: "PLUMBING",
        title: "Concurrent synthetic selection",
      });
      const a = await commands.respond(ids.masterA, {
        orderId: order.id,
        proposedPrice: "10.01",
        message: "A",
      });
      const b = await commands.respond(ids.masterB, {
        orderId: order.id,
        proposedPrice: "20.02",
        message: "B",
      });
      const results = await Promise.allSettled(
        [a, b].map((response) =>
          commands.selectResponse(ids.clientA, {
            orderId: order.id,
            responseId: response.id,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")[0].reason.code).toBe(
        "CONFLICT",
      );
      const selected = await database.order.findUniqueOrThrow({
        where: { id: order.id },
      });
      const winner = [a, b].find(
        (r) => r.masterProfileId === selected.masterProfileId,
      );
      expect(selected.status).toBe("ACCEPTED");
      expect(selected.priceAtOrder.toFixed(2)).toBe(
        winner.proposedPrice.toFixed(2),
      );
      expect(selected.statusHistory).toHaveLength(2);
      expect(selected.statusHistory.at(-1).actorUserId).toBe(ids.clientA);
      await expect(
        rollback((tx) => tx.orderResponse.delete({ where: { id: winner.id } })),
      ).rejects.toThrow();
      await rejects(
        () =>
          commands.respond(ids.masterA, {
            orderId: order.id,
            proposedPrice: "1.00",
            message: "too late",
          }),
        "CONFLICT",
      );
    } finally {
      await database.masterProfile.update({ where: { id: ids.profileB }, data: { city: originalB.city, category: originalB.category } });
    }
  });
});
