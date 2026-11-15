import {
  Category,
  Prisma,
  type OrderStatus,
  type PrismaClient,
} from "../generated/prisma/client.js";
import { publicMasterSelect } from "./dto.js";

type Transaction = Prisma.TransactionClient;
export class OrderError extends Error {
  constructor(
    public readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
  }
}
function text(value: string, field: string, max?: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    (max && value.trim().length > max)
  )
    throw new OrderError("INVALID_INPUT", `Invalid ${field}`);
  return value.trim();
}
function money(value: string): Prisma.Decimal {
  if (typeof value !== "string" || !/^\d{1,8}(\.\d{1,2})?$/.test(value))
    throw new OrderError(
      "INVALID_INPUT",
      "Price must be an exact nonnegative decimal string with at most two fractional digits",
    );
  return new Prisma.Decimal(value);
}
async function actor(tx: Transaction, id: string, role?: "CLIENT" | "MASTER") {
  const user = await tx.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!user || (role && user.role !== role))
    throw new OrderError("FORBIDDEN", "Actor does not have the required role");
  await tx.$executeRaw`SELECT set_config('fixit.actor_id', ${user.id}, true)`;
  return user;
}
async function lockedOrder(tx: Transaction, id: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id=${id}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id } });
  if (!order) throw new OrderError("NOT_FOUND", "Order not found");
  return order;
}
async function masterProfile(tx: Transaction, actorId: string) {
  const user = await actor(tx, actorId, "MASTER");
  await tx.$queryRaw`SELECT id FROM master_profiles WHERE user_id=${user.id}::uuid FOR SHARE`;
  const profile = await tx.masterProfile.findUnique({ where: { userId: user.id } });
  if (!profile) throw new OrderError("FORBIDDEN", "Master profile is required");
  return profile;
}
function audience(profile: { city: string; category: Category }) {
  // Prisma insensitive equals uses ILIKE. Escape wildcard characters so a
  // profile city such as '%' cannot grant access to every city's orders.
  return { city: { equals: profile.city.trim().replace(/[\\%_]/g, "\\$&"), mode: "insensitive" as const }, category: profile.category };
}

/** Internal server command layer. actorId must come from trusted authentication,
 * never a request-body user ID. HTTP controllers delegate mutations here. */
export function createOrderService(database: PrismaClient) {
  return {
    listAvailable(actorId: string) {
      return database.$transaction(async (tx) => {
        const profile = await masterProfile(tx, actorId);
        return tx.order.findMany({
          where: { type: "CUSTOM", status: "OPEN", masterProfileId: null, ...audience(profile) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { responses: { where: { masterProfileId: profile.id }, select: { id: true, message: true, proposedPrice: true, createdAt: true } } },
        });
      });
    },
    listAssigned(actorId: string) {
      return database.$transaction(async (tx) => {
        const profile = await masterProfile(tx, actorId);
        return tx.order.findMany({ where: { type: "CUSTOM", masterProfileId: profile.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      });
    },
    listResponses(actorId: string, orderId: string) {
      return database.$transaction(async (tx) => {
        const client = await actor(tx, actorId, "CLIENT");
        const order = await tx.order.findUnique({ where: { id: orderId }, include: {
          masterProfile: { select: publicMasterSelect },
          responses: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { masterProfile: { select: publicMasterSelect } } },
        } });
        if (!order) throw new OrderError("NOT_FOUND", "Order not found");
        if (order.clientId !== client.id) throw new OrderError("FORBIDDEN", "Only the owner can read responses");
        if (order.type !== "CUSTOM") throw new OrderError("INVALID_INPUT", "Only CUSTOM orders have responses");
        return order;
      });
    },
    createStandard(
      actorId: string,
      input: {
        serviceId: string;
        masterProfileId: string;
        description: string;
      },
    ) {
      const description = text(input.description, "description");
      return database.$transaction(async (tx) => {
        const client = await actor(tx, actorId, "CLIENT");
        await tx.$queryRaw`SELECT id FROM services WHERE id=${input.serviceId}::uuid FOR SHARE`;
        const service = await tx.service.findUnique({
          where: { id: input.serviceId },
          include: { masterProfile: true },
        });
        if (!service) throw new OrderError("NOT_FOUND", "Service not found");
        if (
          !service.isActive ||
          service.masterProfileId !== input.masterProfileId
        )
          throw new OrderError(
            "INVALID_INPUT",
            "Inactive service or wrong master",
          );
        return tx.order.create({
          data: {
            type: "STANDARD",
            status: "PENDING",
            clientId: client.id,
            serviceId: service.id,
            masterProfileId: service.masterProfileId,
            title: service.title,
            city: service.masterProfile.city,
            category: service.category,
            description,
            priceAtOrder: service.priceEstimate,
          },
        });
      });
    },
    createCustom(
      actorId: string,
      input: {
        title: string;
        city: string;
        category: Category;
        description: string;
        budget?: string | null;
      },
    ) {
      const title = text(input.title, "title", 160);
      const city = text(input.city, "city", 100);
      const description = text(input.description, "description");
      const budget = input.budget == null ? null : money(input.budget);
      if (!Object.values(Category).includes(input.category))
        throw new OrderError("INVALID_INPUT", "Invalid category");
      return database.$transaction(async (tx) => {
        const client = await actor(tx, actorId, "CLIENT");
        return tx.order.create({
          data: {
            type: "CUSTOM",
            status: "OPEN",
            clientId: client.id,
            title,
            city,
            category: input.category,
            description,
            budget,
          },
        });
      });
    },
    respond(
      actorId: string,
      input: { orderId: string; proposedPrice?: string | null; message: string },
    ) {
      const proposedPrice = input.proposedPrice == null ? null : money(input.proposedPrice);
      const message = text(input.message, "message");
      return database.$transaction(async (tx) => {
        const profile = await masterProfile(tx, actorId);
        const order = await lockedOrder(tx, input.orderId);
        if (order.type !== "CUSTOM" || order.status !== "OPEN")
          throw new OrderError("CONFLICT", "Order is not open for offers");
        if (
          await tx.orderResponse.findUnique({
            where: {
              orderId_masterProfileId: {
                orderId: order.id,
                masterProfileId: profile.id,
              },
            },
          })
        )
          throw new OrderError("CONFLICT", "Master already responded");
        if (!await tx.order.findFirst({ where: { id: order.id, ...audience(profile) }, select: { id: true } }))
          throw new OrderError("FORBIDDEN", "Order city/category must match the master's profile");
        return tx.orderResponse.create({
          data: {
            orderId: order.id,
            masterProfileId: profile.id,
            proposedPrice,
            message,
          },
        });
      });
    },
    selectResponse(
      actorId: string,
      input: { orderId: string; responseId: string },
    ) {
      return database.$transaction(async (tx) => {
        const client = await actor(tx, actorId, "CLIENT");
        const order = await lockedOrder(tx, input.orderId);
        if (order.clientId !== client.id)
          throw new OrderError("FORBIDDEN", "Only the order owner may choose");
        if (
          order.type !== "CUSTOM" ||
          order.status !== "OPEN" ||
          order.masterProfileId !== null
        )
          throw new OrderError(
            "CONFLICT",
            "Executor already chosen or order closed",
          );
        const response = await tx.orderResponse.findFirst({
          where: { id: input.responseId, orderId: order.id },
        });
        if (!response)
          throw new OrderError(
            "NOT_FOUND",
            "Offer does not belong to this order",
          );
        return tx.order.update({
          where: { id: order.id },
          data: {
            masterProfileId: response.masterProfileId,
            priceAtOrder: response.proposedPrice,
            status: "ACCEPTED",
          },
        });
      });
    },
    transition(
      actorId: string,
      input: { orderId: string; status: OrderStatus },
    ) {
      return database.$transaction(async (tx) => {
        const user = await actor(tx, actorId);
        const order = await lockedOrder(tx, input.orderId);
        const profile =
          user.role === "MASTER"
            ? await tx.masterProfile.findUnique({ where: { userId: user.id } })
            : null;
        const owner = user.role === "CLIENT" && order.clientId === user.id;
        const executor =
          profile !== null && profile.id === order.masterProfileId;
        if (!owner && !executor)
          throw new OrderError("FORBIDDEN", "Actor does not own this order");
        const allowed: Partial<Record<OrderStatus, OrderStatus[]>> = executor
          ? {
              PENDING: ["ACCEPTED", "DECLINED"],
              ACCEPTED: ["IN_PROGRESS"],
              IN_PROGRESS: ["COMPLETED"],
            }
          : {
              OPEN: ["CANCELLED"],
              PENDING: ["CANCELLED"],
              ACCEPTED: ["CANCELLED"],
            };
        if (!allowed[order.status]?.includes(input.status))
          throw new OrderError("CONFLICT", "Status transition is not allowed");
        return tx.order.update({
          where: { id: order.id },
          data: { status: input.status },
        });
      });
    },
  };
}
