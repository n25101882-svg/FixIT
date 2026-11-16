import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";
import { tokenAudience, tokenIssuer } from "../src/auth/token.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const origin = "http://localhost:4200", backend = origin + "/api/v1";
const csrf = { Origin: origin, "X-FixIT-CSRF": "1" };
const password = "Synthetic secure browser session passphrase!", suffix = `@${randomUUID()}.session-browser.fixit.test`;
const city = `Session ${randomUUID().slice(0, 8)}`;
type Account = { id: string; email: string; name: string };
let client: Account, otherClient: Account, master: Account, otherMaster: Account, serviceId: string, serviceTitle: string;
async function account(request: APIRequestContext, name: string, role: "CLIENT" | "MASTER") {
  const response = await request.post(`${backend}/auth/register`, { headers: csrf, data: { name, email: name + suffix, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "PLUMBING", profileDescription: "Synthetic profile", serviceTitle: `Session service ${name} ${suffix.slice(1, 9)}`, serviceDescription: "Synthetic service", priceEstimate: "425.50" } : {}) } });
  expect(response.status()).toBe(201); return (await response.json()).user as Account;
}
async function login(page: Page, actor: Account) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(actor.email); await page.getByLabel("Пароль", { exact: true }).fill(password);
  const result = page.waitForResponse((r) => r.url().endsWith("/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Увійти", exact: true }).click(); const response = await result; expect(response.status()).toBe(200);
  await expect(page.getByText(actor.email, { exact: true })).toBeVisible(); return (await response.json()).accessToken as string;
}
async function refreshCookie(page: Page) {
  const value = (await page.context().cookies()).find((c) => c.name === "__Host-fixit_refresh");
  expect(Boolean(value)).toBe(true); return value!;
}
async function privateState(page: Page) {
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, readableRefresh: document.cookie.includes("fixit_refresh") })))
    .toEqual({ local: 0, session: 0, readableRefresh: false });
}
async function create(page: Page, token: string, type: "CUSTOM" | "STANDARD") {
  const body = type === "CUSTOM" ? { title: `Session CUSTOM ${randomUUID().slice(0, 8)}`, description: "Synthetic browser problem", city, category: "PLUMBING" } : { serviceId, description: "Synthetic STANDARD browser problem" };
  const response = await page.context().request.post(backend + (type === "CUSTOM" ? "/orders" : "/orders/standard"), { headers: { Authorization: `Bearer ${token}` }, data: body });
  expect(response.status()).toBe(201); return (await response.json()).order;
}
test.describe("@sessions production-like single-origin cookie recovery", () => {
  test.beforeAll(async ({ request }) => {
    client = await account(request, "TestClient", "CLIENT"); otherClient = await account(request, "OtherClient", "CLIENT");
    master = await account(request, "TestMaster1", "MASTER"); otherMaster = await account(request, "TestMaster2", "MASTER");
    const service = await database.service.findFirstOrThrow({ where: { masterProfile: { userId: master.id } } }); serviceId = service.id; serviceTitle = service.title;
  });
  test.afterAll(async () => { await database.$disconnect(); }); // Preserve synthetic business/session evidence in *_test.
  test("CLIENT orders and both detail types survive F5; Secure/HttpOnly cookie, logout then F5 denies", async ({ page }) => {
    const token = await login(page, client), original = await refreshCookie(page);
    expect({ httpOnly: original.httpOnly, secure: original.secure, sameSite: original.sameSite, path: original.path, domain: original.domain })
      .toEqual({ httpOnly: true, secure: true, sameSite: "Lax", path: "/", domain: "localhost" });
    const orders = [await create(page, token, "CUSTOM"), await create(page, token, "STANDARD")];
    await page.getByRole("link", { name: "Мої заявки", exact: true }).click(); await page.reload(); await expect(page.getByRole("form", { name: "Нова заявка" })).toBeVisible();
    for (const order of orders) {
      await page.getByRole("article", { name: order.title, exact: true }).getByRole("link", { name: "Переглянути деталі" }).click(); await page.reload();
      await expect(page).toHaveURL(`/orders/${order.id}`); await expect(page.getByRole("article", { name: order.title, exact: true })).toBeVisible();
      await page.getByRole("link", { name: "До моїх замовлень" }).click();
    }
    await privateState(page); expect((await refreshCookie(page)).value !== original.value).toBe(true);
    await page.getByRole("link", { name: "До кабінету", exact: true }).click();
    const out = page.waitForResponse((r) => r.url().endsWith("/auth/logout")); await page.getByRole("button", { name: /Вийти/ }).click(); expect((await out).status()).toBe(204);
    await page.goto("/orders"); await page.reload(); await expect(page.getByRole("form", { name: "Вхід" })).toBeVisible();
    expect((await page.context().cookies()).some((c) => c.name === "__Host-fixit_refresh")).toBe(false);
    expect((await database.authSession.findUniqueOrThrow({ where: { id: original.value.split(".")[1] } })).revokedReason).toBe("logout");
  });
  test("MASTER assignments/detail/feed/services survive direct navigation and F5", async ({ page, browser }) => {
    const context = await browser.newContext(); const clientPage = await context.newPage();
    try {
      const token = await login(clientPage, client), order = await create(clientPage, token, "STANDARD"); await login(page, master);
      await expect(page.getByRole("article", { name: order.title, exact: true }).filter({ has: page.locator(`a[href="/master/orders/${order.id}"]`) })).toBeVisible();
      for (const path of ["/dashboard", `/master/orders/${order.id}`, "/master/orders", "/master/services"]) {
        await page.goto(path);
        // Wait for a positively authenticated view before a deliberate F5; an
        // absent loading element alone can also mean React has not mounted yet.
        await expect(page.getByRole("link", { name: "Мій простір", exact: true })).toBeVisible();
        await page.reload(); await expect(page).toHaveURL(path);
        await expect(page.getByRole("link", { name: "Мій простір", exact: true })).toBeVisible();
        await expect(page.getByRole("form", { name: "Вхід" })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Відновлення сесії" })).toHaveCount(0);
      }
      await privateState(page);
    } finally { await context.close(); }
  });
  test("CUSTOM lifecycle with recovery and private details remains isolated for foreign CLIENT/MASTER", async ({ page, browser }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки", exact: true }).click(); const title = `Full session CUSTOM ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Назва проблеми", { exact: true }).fill(title); await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic real session problem"); await page.getByLabel("Місто", { exact: true }).fill(city); await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST"); await page.getByRole("button", { name: "Створити заявку", exact: true }).click(); const order = (await (await created).json()).order;
    const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    try {
      const mp = await contexts[0]!.newPage(); await login(mp, master); await mp.getByRole("link", { name: /Заявки для майстра/ }).click(); const feed = mp.getByRole("article", { name: title, exact: true });
      await feed.getByLabel("Ваша пропозиція").fill("Synthetic session offer"); await feed.getByRole("button", { name: "Надіслати пропозицію" }).click(); await expect(feed.getByText("Пропозицію надіслано", { exact: true })).toBeVisible();
      const cp = page.getByRole("article", { name: title, exact: true }); await cp.getByRole("button", { name: "Переглянути пропозиції" }).click(); await cp.getByRole("button", { name: "Обрати майстра" }).click(); await page.reload(); await expect(page.getByRole("article", { name: title, exact: true }).getByText("Прийнята", { exact: true })).toBeVisible();
      await mp.getByRole("link", { name: "До кабінету", exact: true }).click(); await mp.reload(); const assigned = mp.getByRole("article", { name: title, exact: true }); await assigned.getByRole("button", { name: "Розпочати роботу" }).click(); await assigned.getByRole("button", { name: "Завершити роботу" }).click(); await expect(assigned.getByText("Завершена", { exact: true })).toBeVisible();
      await page.getByRole("article", { name: title, exact: true }).getByRole("link", { name: "Переглянути деталі" }).click(); await page.reload(); await expect(page.getByRole("list", { name: "Історія статусів" }).locator("li strong")).toHaveText(["Відкрита", "Прийнята", "У роботі", "Завершена"]);
      const outsider = await contexts[1]!.newPage(), foreign = await contexts[2]!.newPage(); await login(outsider, otherClient); await login(foreign, otherMaster);
      for (const [p, path] of [[outsider, `/orders/${order.id}`], [foreign, `/master/orders/${order.id}`]] as const) { await p.goto(path); await expect(p.getByRole("alert")).toHaveText("Заявку не знайдено або вона недоступна."); await expect(p.getByText(title, { exact: true })).toHaveCount(0); }
      const row = await database.order.findUniqueOrThrow({ where: { id: order.id } }); expect(row.status).toBe("COMPLETED");
    } finally { await Promise.all(contexts.map((c) => c.close())); }
  });
  test("STANDARD lifecycle, real production assets and reserved-route SPA isolation", async ({ page, browser }) => {
    await login(page, client); await page.getByRole("link", { name: "Каталог", exact: true }).click();
    await page.getByRole("textbox", { name: "Пошук послуг", exact: true }).fill(serviceTitle); await page.getByRole("button", { name: "Знайти послуги" }).click();
    await page.getByRole("article", { name: serviceTitle, exact: true }).getByRole("button", { name: "Замовити послугу" }).click(); await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic production session booking"); await page.getByRole("checkbox", { name: /Підтверджую/ }).check();
    const result = page.waitForResponse((r) => r.url().endsWith("/orders/standard") && r.request().method() === "POST"); await page.getByRole("button", { name: "Підтвердити замовлення" }).click(); const order = (await (await result).json()).order;
    const context = await browser.newContext(); const mp = await context.newPage();
    try { await login(mp, master); const card = mp.locator(`article:has(a[href="/master/orders/${order.id}"])`); await card.getByRole("button", { name: "Прийняти", exact: true }).click(); await card.getByRole("button", { name: "Розпочати роботу" }).click(); await card.getByRole("button", { name: "Завершити роботу" }).click(); await expect(card.getByText("Завершена", { exact: true })).toBeVisible(); }
    finally { await context.close(); }
    await page.goto(`/orders/${order.id}`); await expect(page.getByRole("article").getByText("Завершена", { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole("article").getByText("Завершена", { exact: true })).toBeVisible();
    for (const path of ["/api/v1/missing", "/health/missing", "/assets/missing.js"]) { const r = await page.context().request.get(origin + path, { headers: { Accept: "text/html" } }); expect(r.status()).toBe(404); expect(r.headers()["content-type"]).not.toContain("text/html"); }
    const asset = await page.locator('script[type="module"]').getAttribute("src"); expect((await page.context().request.get(origin + asset)).status()).toBe(200);
    await privateState(page);
  });
  test("replay revokes only the compromised family; another browser session survives", async ({ page, browser }) => {
    await login(page, client); const old = await refreshCookie(page); const context = await browser.newContext(), mp = await context.newPage();
    try {
      await login(mp, master); await page.reload(); await expect(page.getByText(client.email, { exact: true })).toBeVisible();
      const replay = () => page.context().request.post(`${backend}/auth/refresh`, { headers: { ...csrf, Cookie: old.name + "=" + old.value }, data: {} });
      await expect.poll(async () => (await replay()).status(), { timeout: 6000 }).toBe(401);
      expect((await database.authSession.findUniqueOrThrow({ where: { id: old.value.split(".")[1] } })).revokedReason).toBe("replay");
      await page.reload(); await expect(page.getByRole("form", { name: "Вхід" })).toBeVisible(); await mp.reload(); await expect(mp.getByText(master.email, { exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
  for (const kind of ["idle", "absolute"] as const) test(`${kind} session expiry denies recovery after F5`, async ({ page }) => {
    await login(page, client); const c = await refreshCookie(page), past = new Date(Date.now() - 8 * 86400000);
    await database.authSession.update({ where: { id: c.value.split(".")[1] }, data: { createdAt: past, lastUsedAt: past, ...(kind === "absolute" ? { expiresAt: new Date(Date.now() - 1) } : {}) } });
    await page.reload(); await expect(page.getByRole("form", { name: "Вхід" })).toBeVisible(); expect((await database.authSession.findUniqueOrThrow({ where: { id: c.value.split(".")[1] } })).revokedReason).toBe("expired");
  });
  test("genuine expired access JWT produces 401 then cookie refresh and one successful retry", async ({ page }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки", exact: true }).click(); const before = await refreshCookie(page);
    const expired = jwt.sign({}, process.env.FIXIT_BROWSER_JWT_SECRET!, { algorithm: "HS256", subject: client.id, issuer: tokenIssuer, audience: tokenAudience, expiresIn: -1 });
    let first = true; await page.route("**/api/v1/orders", async (route) => { if (first && route.request().method() === "GET") { first = false; await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${expired}` } }); } else await route.continue(); });
    const denied = page.waitForResponse((r) => r.url().endsWith("/orders") && r.status() === 401), rotated = page.waitForResponse((r) => r.url().endsWith("/auth/refresh") && r.status() === 200);
    await page.getByRole("button", { name: "Оновити", exact: true }).click(); await denied; await rotated; await expect(page.getByRole("form", { name: "Нова заявка" })).toBeVisible();
    expect((await refreshCookie(page)).value !== before.value).toBe(true); await privateState(page);
  });
  test("two same-origin tabs refresh concurrently without destroying the session; logout clears both", async ({ page }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки", exact: true }).click(); const tab = await page.context().newPage();
    try {
      await tab.goto("/orders"); await expect(tab.getByRole("form", { name: "Нова заявка" })).toBeVisible(); const c = await refreshCookie(page), before = await database.authSession.findUniqueOrThrow({ where: { id: c.value.split(".")[1] } });
      await Promise.all([page.reload(), tab.reload()]); await expect(page.getByRole("form", { name: "Нова заявка" })).toBeVisible(); await expect(tab.getByRole("form", { name: "Нова заявка" })).toBeVisible();
      const after = await database.authSession.findUniqueOrThrow({ where: { id: before.id } }); expect(after.generation).toBe(before.generation + 2); expect(after.revokedAt).toBeNull();
      await page.getByRole("link", { name: "До кабінету", exact: true }).click(); const out = page.waitForResponse((r) => r.url().endsWith("/auth/logout")); await page.getByRole("button", { name: /Вийти/ }).click(); await out;
      await expect(tab.getByRole("form", { name: "Вхід" })).toBeVisible(); await tab.reload(); await expect(tab.getByRole("form", { name: "Вхід" })).toBeVisible();
    } finally { await tab.close(); }
  });
  test("offline explicit logout cannot resurrect memory on F5; durable non-secret intent retries revocation", async ({ page }) => {
    await login(page, client); const c = await refreshCookie(page); await page.route("**/auth/logout", (route) => route.abort("internetdisconnected"));
    await page.getByRole("button", { name: /Вийти/ }).click(); await expect(page.getByRole("alert")).toContainText("Вихід не підтверджено");
    expect((await page.context().cookies()).some((item) => item.name === "__Host-fixit_logout_pending" && item.value === "1")).toBe(true);
    await page.unroute("**/auth/logout"); await page.reload(); await expect(page.getByRole("form", { name: "Вхід" })).toBeVisible();
    expect((await database.authSession.findUniqueOrThrow({ where: { id: c.value.split(".")[1] } })).revokedReason).toBe("logout"); await privateState(page);
  });
});
