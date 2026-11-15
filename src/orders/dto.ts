import type { Order, Prisma } from "../generated/prisma/client.js";

export const publicMasterSelect = {
  id: true, city: true, category: true, description: true,
  user: { select: { name: true } },
} satisfies Prisma.MasterProfileSelect;
type Master = Prisma.MasterProfileGetPayload<{ select: typeof publicMasterSelect }>;
export function publicMaster(master: Master) {
  return { id: master.id, name: master.user.name, city: master.city, category: master.category, description: master.description };
}
function completedAt(order: Order): string | null {
  if (order.status !== "COMPLETED" || !Array.isArray(order.statusHistory)) return null;
  for (const event of order.statusHistory) {
    // A legacy migration observation is not the actual completion time.
    if (event && typeof event === "object" && !Array.isArray(event)
      && event.status === "COMPLETED" && event.source === "database" && typeof event.at === "string") {
      const date = new Date(event.at);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}
export function publicOrder(order: Order & { masterProfile?: Master | null }) {
  return {
    id: order.id, clientId: order.clientId, type: order.type,
    serviceId: order.serviceId, masterProfileId: order.masterProfileId,
    title: order.title, description: order.description, city: order.city,
    category: order.category, status: order.status,
    budget: order.budget?.toFixed(2) ?? null, priceAtOrder: order.priceAtOrder?.toFixed(2) ?? null,
    createdAt: order.createdAt, updatedAt: order.updatedAt, statusHistory: order.statusHistory,
    assignedMaster: order.masterProfile ? publicMaster(order.masterProfile) : null,
    completedAt: completedAt(order),
  };
}
export function masterOrder(order: Order) {
  // The MASTER feed/assignments never expose client identity or audit actor IDs.
  return { id: order.id, type: order.type, status: order.status, title: order.title,
    description: order.description, city: order.city, category: order.category,
    budget: order.budget?.toFixed(2) ?? null, serviceId: order.serviceId,
    priceAtOrder: order.priceAtOrder?.toFixed(2) ?? null,
    createdAt: order.createdAt, updatedAt: order.updatedAt, completedAt: completedAt(order) };
}
export function publicResponse(response: {
  id: string; orderId: string; message: string; createdAt: Date;
  proposedPrice: Prisma.Decimal | null; masterProfile: Master;
}) {
  return { id: response.id, orderId: response.orderId, message: response.message,
    proposedPrice: response.proposedPrice?.toFixed(2) ?? null, createdAt: response.createdAt,
    master: publicMaster(response.masterProfile) };
}
