import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1";
const suffix = `@${randomUUID()}.details-browser.fixit.test`, city = `Деталі ${randomUUID().slice(0, 8)}`;
const password = "Synthetic details browser passphrase!";
type Account = { id: string; email: string; token: string };
let client: Account, master: Account, otherMaster: Account, serviceId: string;
const headers = (actor: Account) => ({ Authorization: `Bearer ${actor.token}` });
async function account(request: APIRequestContext, name: string, role: "CLIENT" | "MASTER"): Promise<Account> {
  const email = name + suffix;
  const response = await request.post(`${backend}/auth/register`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "PLUMBING", profileDescription: "Synthetic profile", serviceTitle: "Synthetic details service", serviceDescription: "Synthetic description", priceEstimate: "425.50" } : {}) } });
  expect(response.status()).toBe(201);
  const login = await request.post(`${backend}/auth/login`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password } }); expect(login.status()).toBe(200);
  return { id: (await response.json()).user.id, email, token: (await login.json()).accessToken };
}
async function login(page: Page, actor: Account, target?: string) {
  await page.context().request.post(`${backend}/auth/logout`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: {} });
  await page.goto(target ?? "/login");
  await page.getByLabel("Email", { exact: true }).fill(actor.email); await page.getByLabel("Пароль", { exact: true }).fill(password);
  const result = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Увійти", exact: true }).click(); expect((await result).status()).toBe(200);
  if (target) await expect(page).toHaveURL(target); else await expect(page.getByText(actor.email, { exact: true })).toBeVisible();
}
async function timeline(page: Page, id: string, expected: string[]) {
  const region = page.getByRole("region", { name: "Деталі замовлення" });
  await expect(region.getByText(id, { exact: true })).toBeVisible();
  const list = region.getByRole("list", { name: "Історія статусів" });
  await expect(list.locator("li strong")).toHaveText(expected);
  const stored = await database.order.findUniqueOrThrow({ where: { id } });
  const history = stored.statusHistory as { status: string; at: string }[];
  expect(await list.locator("time").evaluateAll((elements) => elements.map((element) => element.getAttribute("datetime"))))
    .toEqual(history.map((event) => new Date(event.at).toISOString()));
  await expect(region.getByRole("button", { name: /Скасувати|Прийняти|Відхилити|Розпочати|Завершити/ })).toHaveCount(0);
  return stored;
}
async function place(request: APIRequestContext) {
  const response = await request.post(`${backend}/orders/standard`, { headers: headers(client), data: { serviceId, description: `Synthetic details problem ${randomUUID().slice(0, 8)}` } });
  expect(response.status()).toBe(201); return (await response.json()).order;
}
test.describe("@details US-09 private order details and real timeline", () => {
  test.beforeAll(async ({ request }) => {
    client = await account(request, "client", "CLIENT"); master = await account(request, "master-one", "MASTER"); otherMaster = await account(request, "master-two", "MASTER");
    serviceId = (await database.service.findFirstOrThrow({ where: { masterProfile: { userId: master.id } } })).id;
  });
  test.afterAll(async () => { await database.$disconnect(); }); // Retain committed synthetic histories in *_test.

  test("CUSTOM React creation/offering/selection/completion → both private details → foreign MASTER denied → F5 session recovery", async ({ page, browser, request }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки", exact: true }).click();
    const title = `Details CUSTOM ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Назва проблеми", { exact: true }).fill(title); await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic real browser details problem");
    await page.getByLabel("Місто", { exact: true }).fill(city); await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING");
    const createdHTTP = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Створити заявку", exact: true }).click(); const created = await createdHTTP; expect(created.status()).toBe(201); const order = (await created.json()).order;
    const masterContext = await browser.newContext(), foreignContext = await browser.newContext();
    const masterPage = await masterContext.newPage(), foreignPage = await foreignContext.newPage();
    try {
      await login(masterPage, master); await masterPage.getByRole("link", { name: /Заявки для майстра/ }).click();
      const feed = masterPage.getByRole("article", { name: title, exact: true }); await feed.getByLabel("Ваша пропозиція").fill("Synthetic details offer"); await feed.getByRole("button", { name: "Надіслати пропозицію" }).click();
      await expect(feed.getByText("Пропозицію надіслано", { exact: true })).toBeVisible();
      expect((await request.get(`${backend}/master/orders/${order.id}`, { headers: headers(master) })).status()).toBe(404);
      const clientCard = page.getByRole("article", { name: title, exact: true }); await clientCard.getByRole("button", { name: "Переглянути пропозиції" }).click(); await clientCard.getByRole("button", { name: "Обрати майстра" }).click();
      await expect(clientCard.getByText("Прийнята", { exact: true })).toBeVisible(); await masterPage.getByRole("link", { name: "До кабінету", exact: true }).click();
      const assigned = masterPage.getByRole("article", { name: title, exact: true }); await expect(assigned.getByText(/^Створено:/)).toBeVisible(); await assigned.getByRole("button", { name: "Розпочати роботу" }).click(); await assigned.getByRole("button", { name: "Завершити роботу" }).click(); await expect(assigned.getByText("Завершена", { exact: true })).toBeVisible();
      await assigned.getByRole("link", { name: "Переглянути деталі" }).click();
      const row = await timeline(masterPage, order.id, ["Відкрита", "Прийнята", "У роботі", "Завершена"]);
      const masterHTTP = await request.get(`${backend}/master/orders/${order.id}`, { headers: headers(master) }); expect(masterHTTP.status()).toBe(200);
      expect(JSON.stringify(await masterHTTP.json())).not.toMatch(/clientId|actorUserId|statusHistory|email|passwordHash|userId/);
      await clientCard.getByRole("link", { name: "Переглянути деталі" }).click(); await timeline(page, order.id, ["Відкрита", "Прийнята", "У роботі", "Завершена"]);
      expect((await request.get(`${backend}/master/orders/${order.id}`, { headers: headers(otherMaster) })).status()).toBe(404);
      await login(foreignPage, otherMaster, `/master/orders/${order.id}`); await expect(foreignPage.getByRole("alert")).toHaveText("Заявку не знайдено або вона недоступна."); await expect(foreignPage.getByText(title, { exact: true })).toHaveCount(0);
      await page.reload(); // FIX-17: cookie recovery preserves this protected URL without Login.
      await expect(page).toHaveURL(`/orders/${order.id}`); await timeline(page, order.id, ["Відкрита", "Прийнята", "У роботі", "Завершена"]);
      await page.getByRole("button", { name: "Оновити деталі" }).click(); await timeline(page, order.id, ["Відкрита", "Прийнята", "У роботі", "Завершена"]);
      expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).statusHistory).toEqual(row.statusHistory);
    } finally { await masterContext.close(); await foreignContext.close(); }
  });
  test("STANDARD COMPLETED snapshot/details persist for CLIENT and assigned MASTER", async ({ page, browser, request }) => {
    const order = await place(request);
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"]) expect((await request.patch(`${backend}/master/orders/${order.id}/status`, { headers: headers(master), data: { status } })).status()).toBe(200);
    await login(page, client, `/orders/${order.id}`); await timeline(page, order.id, ["Очікує відповіді", "Прийнята", "У роботі", "Завершена"]); await expect(page.getByText("425,50 грн", { exact: true })).toBeVisible();
    const context = await browser.newContext(); const masterPage = await context.newPage();
    try { await login(masterPage, master, `/master/orders/${order.id}`); await timeline(masterPage, order.id, ["Очікує відповіді", "Прийнята", "У роботі", "Завершена"]); }
    finally { await context.close(); }
  });
  test("CLIENT CANCELLED CUSTOM stays in list/details and unassigned MASTER has no access", async ({ page, request }) => {
    const title = `Cancelled details ${randomUUID().slice(0, 8)}`;
    const response = await request.post(`${backend}/orders`, { headers: headers(client), data: { title, description: "Synthetic cancellation details", city, category: "PLUMBING" } }); expect(response.status()).toBe(201); const order = (await response.json()).order;
    await login(page, client); await page.getByRole("link", { name: "Мої заявки", exact: true }).click();
    const card = page.getByRole("article", { name: title, exact: true }); await card.getByRole("button", { name: "Скасувати заявку" }).click(); await page.getByRole("button", { name: "Так, скасувати", exact: true }).click(); await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
    await card.getByRole("link", { name: "Переглянути деталі" }).click(); await timeline(page, order.id, ["Відкрита", "Скасована"]);
    expect((await request.get(`${backend}/master/orders/${order.id}`, { headers: headers(master) })).status()).toBe(404);
    expect(await database.order.count({ where: { id: order.id } })).toBe(1);
  });
  test("STANDARD DECLINED remains readable by both participants with no execution actions", async ({ page, browser, request }) => {
    const order = await place(request); await login(page, master);
    const card = page.getByRole("article", { name: order.title, exact: true }).filter({ has: page.getByRole("button", { name: "Відхилити", exact: true }) });
    await card.getByRole("button", { name: "Відхилити", exact: true }).click();
    // The same title may also belong to earlier fixtures; use the order-specific link.
    await page.locator(`a[href="/master/orders/${order.id}"]`).click(); await timeline(page, order.id, ["Очікує відповіді", "Відхилена"]);
    const context = await browser.newContext(); const clientPage = await context.newPage();
    try { await login(clientPage, client, `/orders/${order.id}`); await timeline(clientPage, order.id, ["Очікує відповіді", "Відхилена"]); }
    finally { await context.close(); }
    expect(await database.order.count({ where: { id: order.id } })).toBe(1);
  });
});
