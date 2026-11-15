import { OrderStatus, type Order, type Prisma } from "../generated/prisma/client.js";
import { z } from "zod";

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
      const time = normalizedEventTime(event.at);
      if (time) return time;
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

const eventTime = z.iso.datetime({ offset: true });
function normalizedEventTime(value: unknown): string | null {
  const valid = eventTime.safeParse(value);
  const time = valid.success ? new Date(valid.data) : null;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
const knownStatuses = new Set<string>(Object.values(OrderStatus));
export interface TimelineEvent {
  status: OrderStatus;
  at: string | null;
  source?: "database" | "legacy_migration";
}
/** Explicit allowlist: audit identities and arbitrary legacy metadata never leave
 * the server. A migration observation is labelled, not invented as a transition.
 * Undated events follow dated events; original order breaks equal-time ties. */
export function safeTimeline(history: unknown): TimelineEvent[] {
  if (!Array.isArray(history)) return [];
  const events: TimelineEvent[] = [];
  for (const value of history) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !knownStatuses.has(value.status)) continue;
    events.push({ status: value.status as OrderStatus,
      at: normalizedEventTime(value.at),
      ...(value.source === "database" || value.source === "legacy_migration" ? { source: value.source } : {}),
    });
  }
  return events.sort((a, b) => a.at === null ? (b.at === null ? 0 : 1)
    : b.at === null ? -1 : a.at.localeCompare(b.at));
}
export function orderDetails(order: Order & { masterProfile?: Master | null }, audience: "CLIENT" | "MASTER") {
  const { statusHistory, ...client } = publicOrder(order);
  const safe = audience === "CLIENT" ? client : { ...masterOrder(order), assignedMaster: client.assignedMaster };
  return { ...safe, timeline: safeTimeline(statusHistory) };
}
export function publicResponse(response: {
  id: string; orderId: string; message: string; createdAt: Date;
  proposedPrice: Prisma.Decimal | null; masterProfile: Master;
}) {
  return { id: response.id, orderId: response.orderId, message: response.message,
    proposedPrice: response.proposedPrice?.toFixed(2) ?? null, createdAt: response.createdAt,
    master: publicMaster(response.masterProfile) };
}
