import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import {
  checkDatabase,
  createDatabaseClient,
} from "../dist/database/client.js";
import { seedDatabase, seedIds } from "../dist/database/seed.js";

// No DATABASE_URL fallback: integration tests must explicitly select a local *_test DB.
const database = createDatabaseClient(
  requireLocalTestDatabase(process.env.TEST_DATABASE_URL),
);

beforeAll(async () => {
  await database.$connect();
  await seedDatabase(database);
});

afterAll(async () => {
  await database.$disconnect();
});

async function rollback(operation) {
  const abort = new Error("intentional test transaction rollback");
  try {
    await database.$transaction(async (tx) => {
      await operation(tx);
      throw abort;
    });
  } catch (error) {
    if (error !== abort) throw error;
  }
}

async function snapshot() {
  return database.$transaction([
    database.user.findMany({ orderBy: { id: "asc" } }),
    database.masterProfile.findMany({ orderBy: { id: "asc" } }),
    database.service.findMany({ orderBy: { id: "asc" } }),
    database.order.findMany({ orderBy: { id: "asc" } }),
    database.orderResponse.findMany({ orderBy: { id: "asc" } }),
  ]);
}

describe("real PostgreSQL migrations, seeding and relations", () => {
  test("initial migration has been applied exactly once", async () => {
    const migrations = await database.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations WHERE migration_name LIKE '%_init_database_schema'
    `;
    expect(migrations).toHaveLength(1);
    expect(migrations[0].finished_at).toBeInstanceOf(Date);
    expect(migrations[0].rolled_back_at).toBeNull();
  });

  test("repeated seeding preserves all rows, hashes, timestamps and order snapshots", async () => {
    const before = await snapshot();
    await seedDatabase(database);
    await seedDatabase(database);
    expect(await snapshot()).toEqual(before);
  });

  test("seed contains synthetic clients, masters and role-linked order/service chains", async () => {
    const users = await database.user.findMany({
      where: { email: { endsWith: "@fixit.test" } },
    });
    expect(users).toHaveLength(5);
    expect(users.filter((u) => u.role === "CLIENT")).toHaveLength(2);
    expect(users.filter((u) => u.role === "MASTER")).toHaveLength(2);
    expect(
      users.every((u) => u.passwordHash.startsWith("scrypt$16384$8$1$")),
    ).toBe(true);
    const orders = await database.order.findMany({
      where: { id: { in: [seedIds.orderA, seedIds.orderB] } },
      include: {
        client: true,
        service: { include: { masterProfile: { include: { user: true } } } },
      },
    });
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      expect(order.client.role).toBe("CLIENT");
      expect(order.service.masterProfile.user.role).toBe("MASTER");
      expect(order.priceAtOrder.toFixed(2)).toBe(
        order.service.priceEstimate.toFixed(2),
      );
    }
  });

  test("database generates UUIDs, timestamps and a PENDING status", async () => {
    await rollback(async (tx) => {
      const order = await tx.order.create({
        data: {
          clientId: seedIds.clientA,
          serviceId: seedIds.serviceA,
          masterProfileId: seedIds.profileA,
          title: "Synthetic",
          city: "Тестоград",
          category: "OTHER",
          description: "Synthetic defaults check",
          priceAtOrder: "250.00",
        },
      });
      expect(order.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(order.createdAt).toBeInstanceOf(Date);
      expect(order.status).toBe("PENDING");
    });
  });

  test("a client may order the same service more than once", async () => {
    await rollback(async (tx) => {
      await tx.order.create({
        data: {
          clientId: seedIds.clientA,
          serviceId: seedIds.serviceA,
          masterProfileId: seedIds.profileA,
          title: "Synthetic",
          city: "Тестоград",
          category: "OTHER",
          description: "Synthetic repeat order",
          priceAtOrder: "250.00",
        },
      });
      expect(
        await tx.order.count({
          where: { clientId: seedIds.clientA, serviceId: seedIds.serviceA },
        }),
      ).toBe(2);
    });
  });

  test("service price changes do not rewrite an existing order price", async () => {
    await rollback(async (tx) => {
      await tx.service.update({
        where: { id: seedIds.serviceA },
        data: { priceEstimate: "990.00" },
      });
      expect(
        (
          await tx.order.findUniqueOrThrow({ where: { id: seedIds.orderA } })
        ).priceAtOrder.toFixed(2),
      ).toBe("250.00");
    });
  });

  test("email is unique and canonical lowercase", async () => {
    await expect(
      rollback((tx) =>
        tx.user.create({
          data: {
            email: "client.a@fixit.test",
            passwordHash: "synthetic",
            name: "Duplicate",
            role: "CLIENT",
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.user.create({
          data: {
            email: "UPPER@fixit.test",
            passwordHash: "synthetic",
            name: "Uppercase",
            role: "CLIENT",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("one master cannot have two profiles", async () => {
    await expect(
      rollback((tx) =>
        tx.masterProfile.create({
          data: {
            userId: seedIds.masterA,
            city: "Synthetic",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("SQL role guards reject a CLIENT profile and a MASTER order", async () => {
    await expect(
      rollback((tx) =>
        tx.masterProfile.create({
          data: {
            userId: seedIds.clientA,
            city: "Synthetic",
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.order.create({
          data: {
            clientId: seedIds.masterA,
            serviceId: seedIds.serviceA,
            masterProfileId: seedIds.profileA,
            title: "Synthetic",
            city: "Тестоград",
            category: "OTHER",
            description: "Wrong role",
            priceAtOrder: "250.00",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("role changes cannot invalidate existing profiles or orders", async () => {
    await expect(
      rollback((tx) =>
        tx.user.update({
          where: { id: seedIds.masterA },
          data: { role: "CLIENT" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.user.update({
          where: { id: seedIds.clientA },
          data: { role: "MASTER" },
        }),
      ),
    ).rejects.toThrow();
  });

  test("foreign keys reject orphan services and orders", async () => {
    await expect(
      rollback((tx) =>
        tx.service.create({
          data: {
            masterProfileId: randomUUID(),
            title: "Orphan",
            category: "OTHER",
            description: "Synthetic",
            priceEstimate: "0.00",
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.order.create({
          data: {
            clientId: seedIds.clientA,
            serviceId: randomUUID(),
            masterProfileId: seedIds.profileA,
            title: "Synthetic",
            city: "Тестоград",
            category: "OTHER",
            description: "Orphan",
            priceAtOrder: "0.00",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test("CHECK constraints reject negative service/order prices", async () => {
    await expect(
      rollback((tx) =>
        tx.service.update({
          where: { id: seedIds.serviceA },
          data: { priceEstimate: "-0.01" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.order.update({
          where: { id: seedIds.orderA },
          data: { priceAtOrder: "-0.01" },
        }),
      ),
    ).rejects.toThrow();
  });

  test("PostgreSQL rejects NULL in required columns and invalid enum values", async () => {
    await expect(
      rollback(
        (tx) =>
          tx.$executeRaw`UPDATE users SET name = NULL WHERE id = ${seedIds.clientA}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      rollback(
        (tx) =>
          tx.$executeRaw`UPDATE orders SET status = 'UNKNOWN' WHERE id = ${seedIds.orderA}::uuid`,
      ),
    ).rejects.toThrow();
  });

  test("ON DELETE RESTRICT preserves user/profile/service order history", async () => {
    await expect(
      rollback((tx) => tx.user.delete({ where: { id: seedIds.clientA } })),
    ).rejects.toThrow();
    await expect(
      rollback((tx) => tx.user.delete({ where: { id: seedIds.masterA } })),
    ).rejects.toThrow();
    await expect(
      rollback((tx) =>
        tx.masterProfile.delete({ where: { id: seedIds.profileA } }),
      ),
    ).rejects.toThrow();
    await expect(
      rollback((tx) => tx.service.delete({ where: { id: seedIds.serviceA } })),
    ).rejects.toThrow();
  });
});

describe("Express health endpoints", () => {
  test("liveness and database readiness return HTTP 200", async () => {
    const app = createApp(() => checkDatabase(database));
    expect((await request(app).get("/health").expect(200)).body).toEqual({
      status: "ok",
    });
    expect((await request(app).get("/health/ready").expect(200)).body).toEqual({
      status: "ok",
      database: "up",
    });
  });

  test("database failure returns 503 without credentials or internal errors", async () => {
    const app = createApp(async () => {
      throw new Error("sensitive connection details");
    });
    expect((await request(app).get("/health/ready").expect(503)).body).toEqual({
      status: "unavailable",
      database: "down",
    });
    await request(app).get("/health").expect(200);
  });

  test("business/auth routes are not accidentally exposed", async () => {
    await request(createApp(() => checkDatabase(database)))
      .get("/users")
      .expect(404);
  });
});
