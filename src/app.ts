import express from "express";

export function createApp(checkDatabase: () => Promise<void>) {
  const app = express();
  app.disable("x-powered-by");

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

  return app;
}
