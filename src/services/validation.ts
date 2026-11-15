import { z } from "zod";
import { Category } from "../generated/prisma/client.js";
import { HttpError } from "../http-error.js";

const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
const city = z.string().max(200).transform(normalize).pipe(z.string().min(1).max(100));
const description = z.string().trim().max(2000).nullable().transform((value) => value || null);
const title = z.string().max(320).transform(normalize).pipe(z.string().min(1).max(160));
const price = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).nullable();
export const profilePatch = z.object({ city, description, category: z.enum(Category) }).partial().strict()
  .refine((body) => Object.keys(body).length > 0);
export const serviceCreate = z.object({ title, category: z.enum(Category), description: description.optional(), priceEstimate: price.optional(), isActive: z.boolean().optional() }).strict();
export const servicePatch = serviceCreate.partial().refine((body) => Object.keys(body).length > 0);
export const uuidParams = z.object({ id: z.uuid() }).strict();
export const empty = z.object({}).strict();
const numberQuery = (fallback: number, max: number) => z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).pipe(z.number().max(max)).optional().transform((value) => value ?? fallback);
export const pagination = z.object({ page: numberQuery(1, 10000), limit: numberQuery(12, 50) }).strict();
export const catalogQuery = pagination.extend({
  city: city.optional(), category: z.enum(Category).optional(),
  q: z.string().max(240).transform(normalize).pipe(z.string().max(120)).optional(),
});
const messages: Record<string, string> = {
  city: "Вкажіть місто: від 1 до 100 символів.", title: "Назва має містити від 1 до 160 символів.",
  description: "Опис має містити не більше 2000 символів.", category: "Оберіть коректну категорію.",
  priceEstimate: "Вкажіть суму від 0 до 99999999.99, максимум дві цифри після крапки.",
  isActive: "Активність має бути true або false.", id: "Некоректний ідентифікатор.",
  q: "Пошук має містити не більше 120 символів.", page: "Вкажіть сторінку від 1 до 10000.", limit: "Вкажіть кількість від 1 до 50.",
};
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    fields[field] = messages[field] ?? "Вкажіть дозволені поля; порожній запит та зайві поля не підтримуються.";
  }
  throw new HttpError(400, "VALIDATION_ERROR", "Перевірте поля форми.", fields);
}
