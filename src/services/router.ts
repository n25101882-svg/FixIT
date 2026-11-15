import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import type { AuthOptions } from "../auth/router.js";
import { authenticate } from "../auth/token.js";
import { HttpError } from "../http-error.js";
import { createServicesService } from "./service.js";
import { catalogQuery, empty, pagination, parse, profilePatch, serviceCreate, servicePatch, uuidParams } from "./validation.js";

export function servicesRouter(options: AuthOptions) {
  const router = Router(); const services = createServicesService(options.database);
  router.get("/catalog/services", async (request, response) => { response.json(await services.catalog(parse(catalogQuery, request.query))); });
  router.get("/catalog/masters/:id", async (request, response) => {
    const { id } = parse(uuidParams, request.params);
    response.json(await services.publicProfile(id, parse(pagination, request.query)));
  });
  router.use(["/master/profile", "/master/services"], authenticate(options), async (_request, response, next) => {
    const user = await options.database.user.findUnique({ where: { id: response.locals.userId as string }, select: { role: true } });
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Увійдіть у свій обліковий запис.");
    if (user.role !== "MASTER") throw new HttpError(403, "FORBIDDEN", "Цей розділ доступний лише майстрам.");
    next();
  });
  router.get("/master/profile", async (request, response) => {
    parse(empty, request.query); response.json({ profile: await services.ownProfile(response.locals.userId as string) });
  });
  router.patch("/master/profile", async (request, response) => {
    parse(empty, request.query); response.json({ profile: await services.updateProfile(response.locals.userId as string, parse(profilePatch, request.body)) });
  });
  router.get("/master/services", async (request, response) => {
    parse(empty, request.query); response.json({ services: await services.ownServices(response.locals.userId as string) });
  });
  router.post("/master/services", async (request, response) => {
    parse(empty, request.query); response.status(201).json({ service: await services.create(response.locals.userId as string, parse(serviceCreate, request.body)) });
  });
  router.patch("/master/services/:id", async (request, response) => {
    const { id } = parse(uuidParams, request.params); parse(empty, request.query);
    response.json({ service: await services.update(response.locals.userId as string, id, parse(servicePatch, request.body)) });
  });
  router.use((error: unknown, _request: unknown, _response: unknown, next: (error: unknown) => void) => {
    next(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
      ? new HttpError(409, "CONFLICT", "Дані змінилися. Оновіть список і повторіть запит.") : error);
  });
  return router;
}
