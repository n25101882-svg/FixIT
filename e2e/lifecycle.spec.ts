import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1";
const suffix = `@${randomUUID()}.lifecycle-browser.fixit.test`;
const city = `Lifecycle ${randomUUID().slice(0, 8)}`;
const password = "Synthetic lifecycle browser passphrase!";
type Account = { id: string; email: string; token: string };
let client: Account, master: Account;
const headers = (user: Account) => ({ Authorization: `Bearer ${user.token}` });
async function account(request: APIRequestContext, name: string, role: "CLIENT" | "MASTER"): Promise<Account> {
  const email = name + suffix;
  const result = await request.post(`${backend}/auth/register`, { data: { email, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "OTHER", profileDescription: "Synthetic profile", serviceTitle: "Synthetic service", serviceDescription: "Synthetic description" } : {}) } });
  expect(result.status()).toBe(201);
  const login = await request.post(`${backend}/auth/login`, { data: { email, password } }); expect(login.status()).toBe(200);
  return { id: (await result.json()).user.id, email, token: (await login.json()).accessToken };
}
async function login(page: Page, actor: Account) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(actor.email);
  await page.getByLabel("Пароль", { exact: true }).fill(password); await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page.getByText(actor.email, { exact: true })).toBeVisible();
}
async function accepted(request: APIRequestContext, title: string) {
  const created = await request.post(`${backend}/orders`, { headers: headers(client), data: { title, description: "Synthetic test problem", city, category: "OTHER" } }); expect(created.status()).toBe(201);
  const order = (await created.json()).order;
  const offered = await request.post(`${backend}/master/orders/${order.id}/responses`, { headers: headers(master), data: { message: "Synthetic offer" } }); expect(offered.status()).toBe(201);
  const selected = await request.post(`${backend}/orders/${order.id}/select-response`, { headers: headers(client), data: { responseId: (await offered.json()).response.id } }); expect(selected.status()).toBe(200);
  return (await selected.json()).order;
}
test.describe("@lifecycle US-08 real browser execution", () => {
  test.beforeAll(async ({ request }) => { client = await account(request, "client", "CLIENT"); master = await account(request, "master", "MASTER"); });
  test.afterAll(async () => { await database.$disconnect(); }); // Retain committed histories in *_test.

  test("CLIENT creates → MASTER offers → CLIENT selects → MASTER starts/completes → CLIENT sees COMPLETED", async ({ page, browser, request }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки" }).click();
    const title = `Full lifecycle ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Назва проблеми", { exact: true }).fill(title); await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic real browser problem");
    await page.getByLabel("Місто", { exact: true }).fill(city); await page.getByLabel("Категорія", { exact: true }).selectOption("OTHER");
    const createdHTTP = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Створити заявку", exact: true }).click();
    const created = await createdHTTP; expect(created.status()).toBe(201); const order = (await created.json()).order;
    const context = await browser.newContext(); const masterPage = await context.newPage();
    try {
      await login(masterPage, master); await masterPage.getByRole("link", { name: /Заявки для майстра/ }).click();
      const feedCard = masterPage.getByRole("article", { name: title, exact: true }); await feedCard.getByLabel("Ваша пропозиція").fill("Synthetic lifecycle offer");
      await feedCard.getByRole("button", { name: "Надіслати пропозицію" }).click(); await expect(feedCard.getByText("Пропозицію надіслано", { exact: true })).toBeVisible();
      const clientCard = page.getByRole("article", { name: title, exact: true });
      await clientCard.getByRole("button", { name: "Переглянути пропозиції" }).click(); await clientCard.getByRole("button", { name: "Обрати майстра" }).click();
      await expect(clientCard.getByText("Прийнята", { exact: true })).toBeVisible();
      await masterPage.getByRole("link", { name: "До кабінету" }).click();
      const masterCard = masterPage.getByRole("article", { name: title, exact: true });
      await expect(masterCard.getByRole("button", { name: "Розпочати роботу" })).toBeVisible();
      let navigations = 0;
      page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
      masterPage.on("framenavigated", (frame) => { if (frame === masterPage.mainFrame()) navigations++; });
      const started = masterPage.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/status`) && r.request().method() === "PATCH");
      await masterCard.getByRole("button", { name: "Розпочати роботу" }).click();
      const startResponse = await started; expect(startResponse.status()).toBe(200); expect(startResponse.request().postDataJSON()).toEqual({ status: "IN_PROGRESS" });
      await expect(masterCard.getByText("У роботі", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Оновити", exact: true }).click(); await expect(clientCard.getByText("У роботі", { exact: true })).toBeVisible();
      await expect(clientCard.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0);
      expect((await request.delete(`${backend}/orders/${order.id}`, { headers: headers(client) })).status()).toBe(409);
      const finished = masterPage.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/status`) && r.request().method() === "PATCH");
      await masterCard.getByRole("button", { name: "Завершити роботу" }).click(); const completedHTTP = await finished; expect(completedHTTP.status()).toBe(200);
      const completed = (await completedHTTP.json()).order; expect(completed.completedAt).toBeTruthy();
      await expect(masterCard.getByText("Завершена", { exact: true })).toBeVisible(); await expect(masterCard.getByRole("button")).toHaveCount(0);
      await expect(masterCard.locator(`time[datetime="${completed.completedAt}"]`)).toBeVisible();
      await page.getByRole("button", { name: "Оновити", exact: true }).click(); await expect(clientCard.getByText("Завершена", { exact: true })).toBeVisible();
      await expect(clientCard.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0); await expect(clientCard.locator(`time[datetime="${completed.completedAt}"]`)).toBeVisible();
      const stored = await database.order.findUniqueOrThrow({ where: { id: order.id } });
      const history = stored.statusHistory as { status: string; actorUserId: string; at: string }[];
      expect(history.map((e) => e.status)).toEqual(["OPEN", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);
      expect(history.slice(2).every((e) => e.actorUserId === master.id)).toBe(true);
      expect(new Date(history.at(-1)!.at).toISOString()).toBe(completed.completedAt); expect(navigations).toBe(0);
    } finally { await context.close(); }
  });
  test("concurrent PATCH commits once and stale MASTER UI reconciles real 409", async ({ page, request }) => {
    const order = await accepted(request, "Concurrent browser lifecycle"); await login(page, master);
    const card = page.getByRole("article", { name: order.title, exact: true }); await expect(card.getByRole("button", { name: "Розпочати роботу" })).toBeVisible();
    const results = await Promise.all([1, 2].map(() => request.patch(`${backend}/master/orders/${order.id}/status`, { headers: headers(master), data: { status: "IN_PROGRESS" } })));
    expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
    const conflict = page.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/status`) && r.status() === 409);
    await card.getByRole("button", { name: "Розпочати роботу" }).click(); await conflict;
    await expect(card.getByRole("button", { name: "Завершити роботу" })).toBeEnabled(); await expect(page.getByRole("alert")).toContainText("Поточний стан");
    expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).statusHistory).toHaveLength(3);
  });
  test("lost completion response after real commit synchronizes without repeating PATCH", async ({ page, request }) => {
    const order = await accepted(request, "Lost response lifecycle");
    expect((await request.patch(`${backend}/master/orders/${order.id}/status`, { headers: headers(master), data: { status: "IN_PROGRESS" } })).status()).toBe(200);
    await login(page, master); const card = page.getByRole("article", { name: order.title, exact: true });
    let patches = 0;
    await page.route(`**/master/orders/${order.id}/status`, async (route) => {
      patches++; const actual = await route.fetch(); expect(actual.status()).toBe(200); await route.abort("failed");
    });
    await card.getByRole("button", { name: "Завершити роботу" }).click(); await expect(card.getByText("Завершена", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Перевірте мережу"); await expect(card.getByRole("button")).toHaveCount(0);
    const row = await database.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe("COMPLETED"); expect(row.statusHistory).toHaveLength(4); expect(patches).toBe(1);
  });
});
