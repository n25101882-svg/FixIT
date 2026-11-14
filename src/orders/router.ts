import { Router } from "express";
import { z } from "zod";
import { Category, type Order } from "../generated/prisma/client.js";
import type { AuthOptions } from "../auth/router.js";
import { authenticate } from "../auth/token.js";
import { HttpError } from "../http-error.js";
import { createOrderService, OrderError } from "./service.js";

const customBody = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  city: z.string().trim().min(1).max(100),
  category: z.enum(Category),
  budget: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).optional(),
}).strict();
const empty = z.object({}).strict();
const orderId = z.object({ id: z.uuid() }).strict();
const fieldMessages: Record<string, string> = {
  title: "Вкажіть назву: від 1 до 160 символів.",
  description: "Опишіть проблему: від 1 до 4000 символів.",
  city: "Вкажіть місто: від 1 до 100 символів.",
  category: "Оберіть одну із запропонованих категорій.",
  budget: "Вкажіть бюджет від 0 до 99999999.99, максимум дві цифри після крапки.",
  id: "Некоректний ідентифікатор заявки.",
};
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    fields[field] = fieldMessages[field] ?? "Запит містить зайві або некоректні поля.";
  }
  throw new HttpError(400, "VALIDATION_ERROR", "Перевірте поля заявки.", fields);
}

function publicOrder(order: Order) {
  return {
    id: order.id, clientId: order.clientId, type: order.type,
    serviceId: order.serviceId, masterProfileId: order.masterProfileId,
    title: order.title, description: order.description, city: order.city,
    category: order.category, status: order.status,
    budget: order.budget?.toFixed(2) ?? null,
    priceAtOrder: order.priceAtOrder?.toFixed(2) ?? null,
    createdAt: order.createdAt, updatedAt: order.updatedAt,
    statusHistory: order.statusHistory,
  };
}
function rethrowOrderError(error: unknown): never {
  if (!(error instanceof OrderError)) throw error;
  const errors = {
    INVALID_INPUT: [400, "Перевірте поля заявки."],
    FORBIDDEN: [403, "Ви не можете змінювати цю заявку."],
    NOT_FOUND: [404, "Заявку не знайдено."],
    CONFLICT: [409, "Поточний стан заявки не дозволяє скасування. Оновіть список."],
  } as const;
  const [status, message] = errors[error.code];
  throw new HttpError(status, error.code, message);
}

export function ordersRouter(options: AuthOptions) {
  const router = Router();
  const orders = createOrderService(options.database);
  router.use("/orders", authenticate(options), async (_request, response, next) => {
    // Endpoint permission/current account check. The command layer still owns
    // transactional ownership/state rules; no role/owner comes from the payload.
    const user = await options.database.user.findUnique({
      where: { id: response.locals.userId as string }, select: { role: true },
    });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Увійдіть у свій обліковий запис.");
    if (user.role !== "CLIENT")
      throw new HttpError(403, "FORBIDDEN", "Заявки доступні лише клієнтам.");
    next();
  });
  router.get("/orders", async (request, response) => {
    parse(empty, request.query);
    const rows = await options.database.order.findMany({
      where: { clientId: response.locals.userId as string },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    response.json({ orders: rows.map(publicOrder) });
  });
  router.post("/orders", async (request, response) => {
    const input = parse(customBody, request.body);
    try {
      const order = await orders.createCustom(response.locals.userId as string, input);
      response.status(201).json({ order: publicOrder(order) });
    } catch (error) { rethrowOrderError(error); }
  });
  router.delete("/orders/:id", async (request, response) => {
    const { id } = parse(orderId, request.params);
    if (request.body !== undefined) parse(empty, request.body);
    try {
      const order = await orders.transition(response.locals.userId as string, {
        orderId: id, status: "CANCELLED",
      });
      response.json({ order: publicOrder(order) });
    } catch (error) { rethrowOrderError(error); }
  });
  return router;
}
