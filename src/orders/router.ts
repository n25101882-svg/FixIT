import { Router } from "express";
import { z } from "zod";
import { Category, OrderStatus, Prisma, type Order } from "../generated/prisma/client.js";
import type { AuthOptions } from "../auth/router.js";
import { authenticate } from "../auth/token.js";
import { HttpError } from "../http-error.js";
import { createOrderService, OrderError } from "./service.js";
import { masterOrder, orderDetails, publicMaster, publicMasterSelect, publicOrder, publicResponse } from "./dto.js";
import { standardSnapshot } from "./standard-snapshot.js";
import { serviceDTO, serviceSelect } from "../services/service.js";

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
  responseId: "Некоректний ідентифікатор пропозиції.",
  message: "Пропозиція має містити від 1 до 2000 символів.",
  status: "Оберіть коректний статус замовлення.",
  serviceId: "Оберіть послугу з коректним ідентифікатором.",
  expectedSnapshot: "Оновіть дані послуги перед підтвердженням.",
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

function rethrowOrderError(error: unknown, operation = "скасування"): never {
  if (!(error instanceof OrderError)) throw error;
  const errors = {
    INVALID_INPUT: [400, "Перевірте поля заявки."],
    FORBIDDEN: [403, "Недостатньо прав або місто/категорія заявки не відповідають профілю."],
    NOT_FOUND: [404, "Заявку не знайдено."],
    CONFLICT: [409, `Поточний стан заявки або наявна пропозиція не дозволяють ${operation}. Оновіть список.`],
  } as const;
  const [status, message] = errors[error.code];
  throw new HttpError(status, error.code, message);
}

export function ordersRouter(options: AuthOptions) {
  const router = Router();
  const orders = createOrderService(options.database);
  async function orderWithMaster(order: Order) {
    const masterProfile = order.masterProfileId ? await options.database.masterProfile.findUnique({
      where: { id: order.masterProfileId }, select: publicMasterSelect,
    }) : null;
    return publicOrder({ ...order, masterProfile });
  }
  router.use("/master/orders", authenticate(options), async (_request, response, next) => {
    const user = await options.database.user.findUnique({ where: { id: response.locals.userId as string }, select: { role: true } });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Увійдіть у свій обліковий запис.");
    if (user.role !== "MASTER") throw new HttpError(403, "FORBIDDEN", "Цей розділ доступний лише майстрам.");
    next();
  });
  router.get("/master/orders/available", async (request, response) => {
    parse(empty, request.query);
    try {
      const rows = await orders.listAvailable(response.locals.userId as string);
      response.json({ orders: rows.map((order) => ({ ...masterOrder(order), myResponse: order.responses[0] ? {
        id: order.responses[0].id, message: order.responses[0].message, createdAt: order.responses[0].createdAt,
      } : null })) });
    } catch (error) { rethrowOrderError(error, "перегляд заявок"); }
  });
  router.get("/master/orders/assigned", async (request, response) => {
    parse(empty, request.query);
    try { response.json({ orders: (await orders.listAssigned(response.locals.userId as string)).map(masterOrder) }); }
    catch (error) { rethrowOrderError(error, "перегляд призначень"); }
  });
  router.get("/master/orders/:id", async (request, response) => {
    const { id } = parse(orderId, request.params); parse(empty, request.query);
    // Ownership is part of the read, including the current account role. Never
    // fetch an unrestricted order and only then check its private fields.
    const order = await options.database.order.findFirst({
      where: { id, masterProfile: { userId: response.locals.userId as string, user: { role: "MASTER" } } },
      include: { masterProfile: { select: publicMasterSelect } },
    });
    if (!order) throw new HttpError(404, "NOT_FOUND", "Заявку не знайдено або вона недоступна.");
    response.json({ order: orderDetails(order, "MASTER") });
  });
  router.patch("/master/orders/:id/status", async (request, response) => {
    const { id } = parse(orderId, request.params);
    parse(empty, request.query);
    const { status } = parse(z.object({ status: z.enum(OrderStatus) }).strict(), request.body);
    try {
      const order = await orders.transition(response.locals.userId as string, { orderId: id, status });
      response.json({ order: masterOrder(order) });
    } catch (error) { rethrowOrderError(error, "зміну статусу"); }
  });
  router.post("/master/orders/:id/responses", async (request, response) => {
    const { id } = parse(orderId, request.params);
    const input = parse(z.object({ message: z.string().trim().min(1).max(2000) }).strict(), request.body);
    try {
      const created = await orders.respond(response.locals.userId as string, { orderId: id, message: input.message });
      response.status(201).json({ response: { id: created.id, orderId: created.orderId, message: created.message, createdAt: created.createdAt } });
    } catch (error) { rethrowOrderError(error, "створення пропозиції"); }
  });
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
      include: { masterProfile: { select: publicMasterSelect } },
    });
    response.json({ orders: rows.map(publicOrder) });
  });
  router.get("/orders/standard/:id", async (request, response) => {
    const { id } = parse(orderId, request.params); parse(empty, request.query);
    const service = await options.database.$transaction((tx) => tx.service.findFirst({ where: { id, isActive: true },
      select: { ...serviceSelect, masterProfileId: true, masterProfile: { select: publicMasterSelect } } }), { isolationLevel: "RepeatableRead" });
    if (!service) throw new HttpError(404, "NOT_FOUND", "Послуга недоступна. Оберіть іншу в каталозі.");
    response.json({ service: { ...serviceDTO(service), master: publicMaster(service.masterProfile) }, snapshot: standardSnapshot(service) });
  });
  router.post("/orders/standard", async (request, response) => {
    parse(empty, request.query);
    const input = parse(z.object({ serviceId: z.uuid(), description: z.string().trim().min(1).max(4000),
      expectedSnapshot: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(), request.body);
    try {
      const order = await orders.createStandard(response.locals.userId as string, input);
      response.status(201).json({ order: await orderWithMaster(order) });
    } catch (error) {
      if ((error instanceof OrderError && ["INVALID_INPUT", "CONFLICT"].includes(error.code))
        || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"))
        throw new HttpError(409, "SERVICE_CHANGED", "Послуга змінилася або недоступна. Оновіть дані й підтвердьте їх ще раз.");
      if (error instanceof OrderError && error.code === "NOT_FOUND") throw new HttpError(404, "NOT_FOUND", "Послугу не знайдено.");
      rethrowOrderError(error, "замовлення послуги");
    }
  });
  router.get("/orders/:id/responses", async (request, response) => {
    const { id } = parse(orderId, request.params); parse(empty, request.query);
    try {
      const order = await orders.listResponses(response.locals.userId as string, id);
      response.json({ order: publicOrder(order), responses: order.responses.map(publicResponse) });
    } catch (error) { rethrowOrderError(error, "перегляд пропозицій"); }
  });
  router.get("/orders/:id", async (request, response) => {
    const { id } = parse(orderId, request.params); parse(empty, request.query);
    const order = await options.database.order.findFirst({
      where: { id, clientId: response.locals.userId as string, client: { role: "CLIENT" } },
      include: { masterProfile: { select: publicMasterSelect } },
    });
    if (!order) throw new HttpError(404, "NOT_FOUND", "Заявку не знайдено або вона недоступна.");
    response.json({ order: orderDetails(order, "CLIENT") });
  });
  router.post("/orders/:id/select-response", async (request, response) => {
    const { id } = parse(orderId, request.params);
    const { responseId } = parse(z.object({ responseId: z.uuid() }).strict(), request.body);
    try {
      const order = await orders.selectResponse(response.locals.userId as string, { orderId: id, responseId });
      response.json({ order: await orderWithMaster(order) });
    } catch (error) { rethrowOrderError(error, "вибір виконавця"); }
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
      response.json({ order: await orderWithMaster(order) });
    } catch (error) { rethrowOrderError(error); }
  });
  return router;
}
