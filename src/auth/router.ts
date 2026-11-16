import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { Category, type PrismaClient } from "../generated/prisma/client.js";
import { HttpError } from "../http-error.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password.js";
import { authenticate, issueToken, type TokenOptions } from "./token.js";
import { createSessionService } from "./sessions.js";
import { sessionCookies } from "./cookies.js";

export interface AuthOptions extends TokenOptions {
  database: PrismaClient;
  corsOrigins: string[];
  rateLimit?: { limit: number; windowMs: number };
  sessions?: { secure?: boolean; clock?: () => Date; refreshLimit?: number };
}

const publicUser = { id: true, email: true, name: true, role: true } as const;
const email = z.string().trim().toLowerCase().max(254).email();
const commonRegistration = {
  email,
  password: z.string().min(12).max(128),
  passwordConfirmation: z.string().min(12).max(128),
  name: z.string().trim().min(2).max(100),
};
const registerBody = z.preprocess(
  // Preserve the existing default CLIENT contract without accepting MASTER fields.
  (body) => typeof body === "object" && body !== null && !("role" in body)
    ? { ...body, role: "CLIENT" }
    : body,
  z.discriminatedUnion("role", [
    z.object({ ...commonRegistration, role: z.literal("CLIENT") }).strict(),
    z.object({
      ...commonRegistration,
      role: z.literal("MASTER"),
      city: z.string().trim().min(1).max(100),
      category: z.enum(Category),
      profileDescription: z.string().trim().min(1).max(2000),
      serviceTitle: z.string().trim().min(1).max(160),
      serviceDescription: z.string().trim().min(1).max(2000),
      priceEstimate: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).optional(),
    }).strict(),
  ]).refine((input) => input.password === input.passwordConfirmation, {
    path: ["passwordConfirmation"],
    message: "Passwords must match",
  }),
);
const loginBody = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? "form");
      const messages: Record<string, string> = {
        role: "Оберіть роль клієнта або майстра.",
        password: "Пароль має містити від 12 до 128 символів.",
        passwordConfirmation: "Підтвердження має збігатися з паролем.",
        name: "Ім’я має містити від 2 до 100 символів.",
        email: "Вкажіть коректну адресу email.",
        city: "Вкажіть місто: від 1 до 100 символів.",
        category: "Оберіть одну із запропонованих категорій.",
        profileDescription: "Опишіть свій досвід: від 1 до 2000 символів.",
        serviceTitle: "Вкажіть назву першої послуги: від 1 до 160 символів.",
        serviceDescription: "Опишіть першу послугу: від 1 до 2000 символів.",
        priceEstimate: "Вкажіть суму від 0 до 99999999.99, максимум дві цифри після крапки.",
      };
      fields[name] = messages[name] ?? "Запит містить зайві або некоректні поля.";
    }
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "Перевірте поля форми.",
      fields,
    );
  }
  return result.data;
}

export function authRouter(options: AuthOptions) {
  const router = Router();
  const sessions = createSessionService(options.database, options.jwtSecret, options.sessions?.clock);
  const cookies = sessionCookies(options.sessions?.secure);
  router.use(["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"], (request, _response, next) => {
    if (request.method === "POST") {
      if (!request.headers.origin || !options.corsOrigins.includes(request.headers.origin)
        || request.get("X-FixIT-CSRF") !== "1" || !request.is("application/json") || request.get("Sec-Fetch-Site") === "cross-site")
        throw new HttpError(403, "CSRF_REJECTED", "Джерело запиту не підтверджено.");
      cookies.guard(request);
    }
    next();
  });
  const refreshLimiter = rateLimit({ windowMs: 60000, limit: options.sessions?.refreshLimit ?? 60,
    keyGenerator: (_request, response) => response.locals.refreshId as string,
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: { code: "REFRESH_RATE_LIMITED", message: "Зачекайте перед повторним оновленням сесії." } } });
  const invalidRefreshLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  router.post("/auth/refresh", (request, response, next) => {
    parse(z.object({}).strict(), request.body); parse(z.object({}).strict(), request.query);
    const id = sessions.identify(cookies.read(request));
    if (!id) return invalidRefreshLimiter(request, response, () => next(new HttpError(401, "UNAUTHORIZED", "Сесію не вдалося відновити.")));
    response.locals.refreshId = id; next();
  }, refreshLimiter, async (request, response) => {
    const result = await sessions.rotate(cookies.read(request));
    if (result.kind === "conflict") {
      response.setHeader("Retry-After", "1");
      throw new HttpError(409, "REFRESH_CONFLICT", "Інший запит уже оновлює сесію. Повторіть перевірку.");
    }
    if (result.kind !== "ok") throw new HttpError(401, "UNAUTHORIZED", "Сесію не вдалося відновити.");
    cookies.set(response, result.token, result.expiresAt);
    response.json({ accessToken: issueToken(result.user.id, options), tokenType: "Bearer", expiresIn: options.tokenTtlSeconds, user: result.user });
  });
  router.post("/auth/logout", async (request, response) => {
    parse(z.object({}).strict(), request.body); parse(z.object({}).strict(), request.query);
    await sessions.revoke(cookies.read(request));
    cookies.clear(response); response.status(204).end();
  });
  const unknownAccountHash = dummyPasswordHash();
  const limiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 15 * 60 * 1000,
    limit: options.rateLimit?.limit ?? 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Забагато спроб. Спробуйте пізніше.",
      },
    },
  });

  router.post("/auth/register", limiter, async (request, response) => {
    const input = parse(registerBody, request.body);
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await options.database.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            name: input.name,
            role: input.role,
          },
          select: publicUser,
        });
        if (input.role === "MASTER") {
          const profile = await tx.masterProfile.create({
            data: {
              userId: created.id,
              city: input.city,
              category: input.category,
              description: input.profileDescription,
            },
          });
          await tx.service.create({
            data: {
              masterProfileId: profile.id,
              category: input.category,
              title: input.serviceTitle,
              description: input.serviceDescription,
              // Prisma accepts the validated exact decimal string; never Number/Float.
              priceEstimate: input.priceEstimate ?? null,
            },
          });
        }
        return created;
      });
      // $transaction resolves after commit. A failed profile/service yields no 201.
      response.status(201).json({ user });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        throw new HttpError(
          409,
          "EMAIL_TAKEN",
          "Цей email уже зареєстрований.",
          { email: "Цей email уже зареєстрований." },
        );
      }
      throw error;
    }
  });

  router.post("/auth/login", limiter, async (request, response) => {
    const input = parse(loginBody, request.body);
    const user = await options.database.user.findUnique({
      where: { email: input.email },
      select: { ...publicUser, passwordHash: true },
    });
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? unknownAccountHash,
    );
    if (!user || !valid)
      throw new HttpError(
        401,
        "INVALID_CREDENTIALS",
        "Неправильний email або пароль.",
      );
    const session = await sessions.create(user.id, cookies.read(request));
    cookies.set(response, session.token, session.expiresAt);
    response.json({
      accessToken: issueToken(user.id, options),
      tokenType: "Bearer",
      expiresIn: options.tokenTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  });

  router.get("/users/me", authenticate(options), async (_request, response) => {
    const user = await options.database.user.findUnique({
      where: { id: response.locals.userId as string },
      select: publicUser,
    });
    if (!user)
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Увійдіть у свій обліковий запис.",
      );
    response.json({ user });
  });

  return router;
}
