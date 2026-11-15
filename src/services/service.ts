import { Prisma, type PrismaClient, type Service } from "../generated/prisma/client.js";
import { HttpError } from "../http-error.js";
import { publicMaster, publicMasterSelect } from "../orders/dto.js";
import type { z } from "zod";
import type { catalogQuery, profilePatch, serviceCreate, servicePatch } from "./validation.js";

export const serviceSelect = { id: true, title: true, category: true, description: true, priceEstimate: true, isActive: true } satisfies Prisma.ServiceSelect;
export const serviceDTO = (row: Pick<Service, "id" | "title" | "category" | "description" | "priceEstimate" | "isActive">) => ({ id: row.id, title: row.title, category: row.category, description: row.description, isActive: row.isActive, priceEstimate: row.priceEstimate?.toFixed(2) ?? null });
const literal = (value: string) => value.replace(/[\\%_]/g, "\\$&");
type Page = { page: number; limit: number };
const meta = ({ page, limit }: Page, total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });
async function profile(tx: Prisma.TransactionClient, actorId: string, editing = false) {
  const user = await tx.user.findUnique({ where: { id: actorId }, select: { role: true } });
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Увійдіть у свій обліковий запис.");
  if (user.role !== "MASTER") throw new HttpError(403, "FORBIDDEN", "Цей розділ доступний лише майстрам.");
  // Interlocks with respond()'s profile SHARE lock; never changes order snapshots.
  if (editing) await tx.$queryRaw`SELECT id FROM master_profiles WHERE user_id=${actorId}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM master_profiles WHERE user_id=${actorId}::uuid FOR SHARE`;
  const row = await tx.masterProfile.findUnique({ where: { userId: actorId }, select: publicMasterSelect });
  if (!row) throw new HttpError(403, "PROFILE_REQUIRED", "Профіль майстра недоступний.");
  return row;
}
export function createServicesService(database: PrismaClient) {
  return {
    ownProfile(actorId: string) {
      return database.$transaction(async (tx) => publicMaster(await profile(tx, actorId)));
    },
    updateProfile(actorId: string, input: z.infer<typeof profilePatch>) {
      return database.$transaction(async (tx) => {
        const owner = await profile(tx, actorId, true);
        return publicMaster(await tx.masterProfile.update({ where: { id: owner.id }, data: input, select: publicMasterSelect }));
      });
    },
    ownServices(actorId: string) {
      return database.$transaction(async (tx) => {
        const owner = await profile(tx, actorId);
        return (await tx.service.findMany({ where: { masterProfileId: owner.id }, orderBy: [{ title: "asc" }, { id: "asc" }], select: serviceSelect })).map(serviceDTO);
      });
    },
    create(actorId: string, input: z.infer<typeof serviceCreate>) {
      return database.$transaction(async (tx) => {
        const owner = await profile(tx, actorId);
        return serviceDTO(await tx.service.create({ data: { ...input, masterProfileId: owner.id }, select: serviceSelect }));
      });
    },
    update(actorId: string, id: string, input: z.infer<typeof servicePatch>) {
      return database.$transaction(async (tx) => {
        const owner = await profile(tx, actorId);
        // Same 404 for unknown and foreign services. SHARE locks in createStandard
        // prevent mutable service fields from changing during snapshot creation.
        await tx.$queryRaw`SELECT id FROM services WHERE id=${id}::uuid AND master_profile_id=${owner.id}::uuid FOR UPDATE`;
        if (!await tx.service.findFirst({ where: { id, masterProfileId: owner.id }, select: { id: true } }))
          throw new HttpError(404, "NOT_FOUND", "Послугу не знайдено.");
        return serviceDTO(await tx.service.update({ where: { id }, data: input, select: serviceSelect }));
      });
    },
    async catalog(query: z.infer<typeof catalogQuery>) {
      const where: Prisma.ServiceWhereInput = {
        isActive: true,
        ...(query.city ? { masterProfile: { city: { equals: literal(query.city), mode: "insensitive" } } } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.q ? { OR: [{ title: { contains: literal(query.q), mode: "insensitive" } }, { description: { contains: literal(query.q), mode: "insensitive" } }] } : {}),
      };
      const [total, rows] = await database.$transaction([
        database.service.count({ where }),
        database.service.findMany({ where, select: { ...serviceSelect, masterProfile: { select: publicMasterSelect } },
          orderBy: [{ title: "asc" }, { id: "asc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      ], { isolationLevel: "RepeatableRead" });
      return { ...meta(query, total), services: rows.map(({ masterProfile, ...row }) => ({ ...serviceDTO(row), master: publicMaster(masterProfile) })) };
    },
    publicProfile(id: string, query: Page) {
      return database.$transaction(async (tx) => {
        const owner = await tx.masterProfile.findUnique({ where: { id }, select: publicMasterSelect });
        if (!owner) throw new HttpError(404, "NOT_FOUND", "Майстра не знайдено.");
        const where = { masterProfileId: id, isActive: true };
        const total = await tx.service.count({ where });
        const services = await tx.service.findMany({ where, select: serviceSelect, orderBy: [{ title: "asc" }, { id: "asc" }], skip: (query.page - 1) * query.limit, take: query.limit });
        return { master: publicMaster(owner), ...meta(query, total), services: services.map(serviceDTO) };
      }, { isolationLevel: "RepeatableRead" });
    },
  };
}
