import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import type { PrismaClient } from "../generated/prisma/client.js";

const deriveKey = promisify(scrypt);

// Stable synthetic identities: reruns update fixtures, never delete unrelated rows.
export const seedIds = {
  admin: "10000000-0000-4000-8000-000000000001",
  clientA: "10000000-0000-4000-8000-000000000002",
  clientB: "10000000-0000-4000-8000-000000000003",
  masterA: "10000000-0000-4000-8000-000000000004",
  masterB: "10000000-0000-4000-8000-000000000005",
  profileA: "20000000-0000-4000-8000-000000000001",
  profileB: "20000000-0000-4000-8000-000000000002",
  serviceA: "30000000-0000-4000-8000-000000000001",
  serviceB: "30000000-0000-4000-8000-000000000002",
  serviceC: "30000000-0000-4000-8000-000000000003",
  orderA: "40000000-0000-4000-8000-000000000001",
  orderB: "40000000-0000-4000-8000-000000000002",
} as const;

async function unusableRandomPasswordHash(): Promise<string> {
  const salt = randomBytes(16);
  // The random input is discarded. No shared/default login password is seeded.
  const key = await deriveKey(randomBytes(32), salt, 64) as Buffer;
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function seedDatabase(database: PrismaClient) {
  const users = [
    { id: seedIds.admin, email: "admin@fixit.test", name: "Тестовий адміністратор", role: "ADMIN" as const },
    { id: seedIds.clientA, email: "client.a@fixit.test", name: "Тестовий клієнт А", role: "CLIENT" as const },
    { id: seedIds.clientB, email: "client.b@fixit.test", name: "Тестовий клієнт Б", role: "CLIENT" as const },
    { id: seedIds.masterA, email: "master.a@fixit.test", name: "Тестовий майстер А", role: "MASTER" as const },
    { id: seedIds.masterB, email: "master.b@fixit.test", name: "Тестовий майстер Б", role: "MASTER" as const },
  ];
  const hashes = await Promise.all(users.map(() => unusableRandomPasswordHash()));

  return database.$transaction(async (tx) => {
    // Serialize concurrent seed runs; the lock is released with this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(617202606)`;
    const actualUsers = [];
    for (const [index, user] of users.entries()) {
      actualUsers.push(await tx.user.upsert({
        where: { email: user.email },
        create: { ...user, passwordHash: hashes[index]! },
        update: { name: user.name, role: user.role },
      }));
    }
    const [admin, clientA, clientB, masterA, masterB] = actualUsers;
    if (!admin || !clientA || !clientB || !masterA || !masterB) throw new Error("Incomplete seed fixtures.");

    const profileA = await tx.masterProfile.upsert({
      where: { userId: masterA.id },
      create: { id: seedIds.profileA, userId: masterA.id, city: "Тестоград", bio: "Синтетичний профіль сантехніка.", isApproved: true },
      update: { city: "Тестоград", bio: "Синтетичний профіль сантехніка.", isApproved: true },
    });
    await tx.masterProfile.upsert({
      where: { userId: masterB.id },
      create: { id: seedIds.profileB, userId: masterB.id, city: "Прикладськ", bio: null, isApproved: false },
      update: { city: "Прикладськ", bio: null, isApproved: false },
    });

    const services = [
      { id: seedIds.serviceA, masterProfileId: profileA.id, title: "Заміна змішувача", category: "PLUMBING", description: "Синтетична послуга для перевірки замовлень.", priceCents: 25000, isActive: true },
      { id: seedIds.serviceB, masterProfileId: profileA.id, title: "Діагностика протікання", category: "PLUMBING", description: "Синтетична неактивна послуга.", priceCents: 15000, isActive: false },
      { id: seedIds.serviceC, masterProfileId: profileA.id, title: "Монтаж сифона", category: "PLUMBING", description: "Синтетична додаткова послуга.", priceCents: 40000, isActive: true },
    ];
    for (const service of services) {
      await tx.service.upsert({ where: { id: service.id }, create: service, update: service });
    }
    const orders = [
      { id: seedIds.orderA, clientId: clientA.id, serviceId: seedIds.serviceA, description: "Синтетична заявка клієнта А.", priceAtOrderCents: 25000, status: "PENDING" as const },
      { id: seedIds.orderB, clientId: clientB.id, serviceId: seedIds.serviceC, description: "Синтетична прийнята заявка клієнта Б.", priceAtOrderCents: 40000, status: "ACCEPTED" as const },
    ];
    for (const order of orders) {
      // Existing order history, prices and statuses are deliberately preserved.
      await tx.order.upsert({ where: { id: order.id }, create: order, update: {} });
    }
    return { users: users.length, masterProfiles: 2, services: services.length, orders: orders.length };
  }, { timeout: 15000 });
}
