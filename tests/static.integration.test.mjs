import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";

const dir = mkdtempSync(join(tmpdir(), "fixit-static-tests-"));
mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html><title>Synthetic FixIT</title>");
writeFileSync(join(dir, "assets/app.js"), "/* synthetic public asset */"); writeFileSync(join(dir, ".env"), "SYNTHETIC_PRIVATE=unused");
const app = createApp(async () => {}, undefined, { frontendDir: dir });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
test.each(["/", "/catalog", "/login", "/orders", "/orders/40000000-0000-4000-8000-000000000091", "/master/services"])("HTML navigation %s serves the same SPA without caching", async (path) => {
  const response = await request(app).get(path).set("Accept", "text/html").expect(200); expect(response.type).toBe("text/html"); expect(response.text).toContain("Synthetic FixIT"); expect(response.headers["cache-control"]).toBe("no-cache");
});
test.each(["/api", "/api/v1/unknown", "/api/v1/auth/unknown", "/health/missing", "/%61pi/v1/unknown", "/%68ealth/missing"])("reserved %s stays JSON 404, never SPA", async (path) => {
  const response = await request(app).get(path).set("Accept", "text/html").expect(404); expect(response.type).toBe("application/json"); expect(response.text).not.toContain("doctype");
});
test("health endpoints retain their semantics and assets retain safe headers", async () => {
  await request(app).get("/health").expect(200); await request(app).get("/health/ready").expect(200);
  const asset = await request(app).get("/assets/app.js").expect(200); expect(asset.headers["cache-control"]).toContain("immutable"); expect(asset.headers["x-content-type-options"]).toBe("nosniff"); expect(asset.headers["x-frame-options"]).toBe("DENY");
});
test.each(["/assets/missing.js", "/.env", "/missing.css"])("missing/private file %s never gets index HTML", async (path) => { const response = await request(app).get(path).set("Accept", "text/html").expect(404); expect(response.text).not.toContain("SYNTHETIC_PRIVATE"); expect(response.text).not.toContain("doctype"); });
