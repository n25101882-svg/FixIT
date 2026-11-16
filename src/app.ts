import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { authRouter, type AuthOptions } from "./auth/router.js";
import { HttpError } from "./http-error.js";
import { ordersRouter } from "./orders/router.js";
import { servicesRouter } from "./services/router.js";
import { extname, join } from "node:path";

export function createApp(
  checkDatabase: () => Promise<void>,
  auth?: AuthOptions,
  http: { trustProxyHops?: 0 | 1; frontendDir?: string } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  // Opt-in, bounded ingress trust; local development continues to trust none.
  app.set("trust proxy", http.trustProxyHops === 1 ? 1 : false);

  if (auth) {
    app.use(
      "/api/v1",
      (_request, response, next) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        next();
      },
      cors((request, done) => done(null, {
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
        credentials: request.url.startsWith("/auth/"),
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "X-FixIT-CSRF"],
        maxAge: 600,
      })),
      express.json({ limit: "16kb" }),
      authRouter(auth),
      ordersRouter(auth),
      servicesRouter(auth),
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

  // Reserved server namespaces never return an HTML SPA, even for Accept: html.
  app.use(["/api", "/health"], (_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Маршрут не знайдено." } });
  });
  if (http.frontendDir) {
    app.use((request, response, next) => {
      let path: string;
      try { path = decodeURIComponent(request.path); } catch { return next(); }
      if (/^\/(api|health)(\/|$)/i.test(path) || path.split("/").some((part) => part.startsWith(".")))
        return response.status(404).json({ error: { code: "NOT_FOUND", message: "Маршрут не знайдено." } });
      next();
    });
    app.use(express.static(http.frontendDir, { index: false, dotfiles: "deny", redirect: false,
      setHeaders(response, path) { response.setHeader("Cache-Control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"); } }));
    app.get("/{*path}", (request, response, next) => {
      let path: string;
      try { path = decodeURIComponent(request.path); } catch { return next(); }
      if (path.split("/").some((part) => part.startsWith(".")) || extname(path) || path.startsWith("/assets/") || !request.get("accept")?.includes("text/html")) return next();
      response.setHeader("Cache-Control", "no-cache");
      response.sendFile(join(http.frontendDir!, "index.html"));
    });
  }

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
