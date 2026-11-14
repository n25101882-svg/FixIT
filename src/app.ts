import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { authRouter, type AuthOptions } from "./auth/router.js";
import { HttpError } from "./http-error.js";
import { ordersRouter } from "./orders/router.js";

export function createApp(
  checkDatabase: () => Promise<void>,
  auth?: AuthOptions,
) {
  const app = express();
  app.disable("x-powered-by");

  if (auth) {
    app.use(
      "/api/v1",
      (_request, response, next) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        next();
      },
      cors({
        origin(origin, callback) {
          if (!origin || auth.corsOrigins.includes(origin))
            callback(null, true);
          else
            callback(
              new HttpError(
                403,
                "ORIGIN_NOT_ALLOWED",
                "Джерело запиту не дозволене.",
              ),
            );
        },
        credentials: false,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type"],
        maxAge: 600,
      }),
      express.json({ limit: "16kb" }),
      authRouter(auth),
      ordersRouter(auth),
    );
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    try {
      await checkDatabase();
      response.json({ status: "ok", database: "up" });
    } catch {
      response.status(503).json({ status: "unavailable", database: "down" });
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof HttpError) {
      response
        .status(error.status)
        .json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.fields ? { fields: error.fields } : {}),
          },
        });
    } else if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.parse.failed"
    ) {
      response
        .status(400)
        .json({
          error: { code: "INVALID_JSON", message: "Некоректний JSON." },
        });
    } else if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      response
        .status(413)
        .json({
          error: { code: "PAYLOAD_TOO_LARGE", message: "Запит завеликий." },
        });
    } else {
      // Do not expose passwords, tokens, SQL, stack traces or database errors.
      response
        .status(500)
        .json({
          error: {
            code: "INTERNAL_ERROR",
            message: "Не вдалося виконати запит. Спробуйте пізніше.",
          },
        });
    }
  };
  app.use(handleError);

  return app;
}
