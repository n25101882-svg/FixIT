import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1";
const suffix = `@${randomUUID()}.offers-browser.fixit.test`;
const city = `Місто ${randomUUID().slice(0, 8)}`;
const password = "Synthetic browser offers passphrase!";
type Account = { id: string; email: string; token: string };
let client: Account, outsider: Account, master: Account, second: Account, otherCity: Account;
async function account(request: APIRequestContext, name: string, role = "CLIENT", profileCity = city): Promise<Account> {
  const email = name + suffix;
  const created = await request.post(`${backend}/auth/register`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city: profileCity, category: "PLUMBING", profileDescription: "Synthetic profile", serviceTitle: "Synthetic service", serviceDescription: "Synthetic service description" } : {}) } });
  expect(created.status()).toBe(201);
  const loggedIn = await request.post(`${backend}/auth/login`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password } }); expect(loggedIn.status()).toBe(200);
  return { id: (await created.json()).user.id, email, token: (await loggedIn.json()).accessToken };
}
async function login(page: Page, user: Account) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill(password); await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
}
const headers = (user: Account) => ({ Authorization: `Bearer ${user.token}` });
async function create(request: APIRequestContext, title: string) {
  const result = await request.post(`${backend}/orders`, { headers: headers(client), data: { title, description: "Synthetic browser problem", city, category: "PLUMBING" } });
  expect(result.status()).toBe(201); return (await result.json()).order;
}
test.describe("@offers real CUSTOM offer and assignment workflow", () => {
  test.beforeAll(async ({ request }) => {
    client = await account(request, "client"); outsider = await account(request, "outsider");
    master = await account(request, "master", "MASTER"); second = await account(request, "second", "MASTER");
    otherCity = await account(request, "elsewhere", "MASTER", "Elsewhere");
  });
  test.afterAll(async () => {
    // Retain selected synthetic history in this explicit local *_test DB.
    await database.$disconnect();
  });
  test("React client → MASTER text offer → client selects → assigned MASTER dashboard and persisted ACCEPTED", async ({ page, browser, request }) => {
    await login(page, client); await page.getByRole("link", { name: "Мої заявки" }).click();
    const title = `Browser CUSTOM ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Назва проблеми", { exact: true }).fill(title);
    await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic problem without private data");
    await page.getByLabel("Місто", { exact: true }).fill(city); await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING");
    const creation = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Створити заявку", exact: true }).click();
    const http = await creation; expect(http.status()).toBe(201); const order = (await http.json()).order;
    const context = await browser.newContext(); const masterPage = await context.newPage();
    try {
      await login(masterPage, master); await masterPage.getByRole("link", { name: /Заявки для майстра/ }).click();
      const card = masterPage.getByRole("article", { name: title, exact: true }); await expect(card).toBeVisible();
      await card.getByLabel("Ваша пропозиція").fill("Synthetic offer: ready to help");
      const offered = masterPage.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/responses`) && r.request().method() === "POST");
      await card.getByRole("button", { name: "Надіслати пропозицію" }).click(); expect((await offered).status()).toBe(201);
      await expect(card.getByText("Пропозицію надіслано", { exact: true })).toBeVisible();
      const clientCard = page.getByRole("article", { name: title, exact: true });
      await clientCard.getByRole("button", { name: "Переглянути пропозиції" }).click();
      await expect(clientCard.getByText("Synthetic offer: ready to help")).toBeVisible();
      expect((await request.get(`${backend}/orders/${order.id}/responses`, { headers: headers(outsider) })).status()).toBe(403);
      const selection = page.waitForResponse((r) => r.url().endsWith(`/orders/${order.id}/select-response`));
      await clientCard.getByRole("button", { name: "Обрати майстра" }).click(); expect((await selection).status()).toBe(200);
      await expect(clientCard.getByText("Прийнята", { exact: true })).toBeVisible(); await expect(clientCard.getByText("Виконавець: Synthetic master")).toBeVisible();
      await masterPage.getByRole("link", { name: "До кабінету" }).click();
      const assigned = masterPage.getByRole("region", { name: "Призначені заявки" }).getByRole("article", { name: title });
      await expect(assigned.getByText("Прийнята", { exact: true })).toBeVisible();
      const stored = await database.order.findUniqueOrThrow({ where: { id: order.id }, include: { responses: true, masterProfile: true } });
      expect(stored.status).toBe("ACCEPTED"); expect(stored.masterProfile?.userId).toBe(master.id); expect(stored.responses).toHaveLength(1);
      expect((stored.statusHistory as { status: string }[]).map((e) => e.status)).toEqual(["OPEN", "ACCEPTED"]);
    } finally { await context.close(); }
  });
  test("server filters city, refuses role/duplicate, and browser refreshes a real 409", async ({ page, request }) => {
    const order = await create(request, "Browser duplicate conflict");
    const unavailable = await request.get(`${backend}/master/orders/available`, { headers: headers(otherCity) });
    expect((await unavailable.json()).orders.some((r: { id: string }) => r.id === order.id)).toBe(false);
    expect((await request.post(`${backend}/master/orders/${order.id}/responses`, { headers: headers(otherCity), data: { message: "Bypass" } })).status()).toBe(403);
    expect((await request.get(`${backend}/master/orders/available`, { headers: headers(client) })).status()).toBe(403);
    await login(page, master); await page.getByRole("link", { name: /Заявки для майстра/ }).click();
    const card = page.getByRole("article", { name: order.title, exact: true }); await card.getByLabel("Ваша пропозиція").fill("Attempt duplicate");
    expect((await request.post(`${backend}/master/orders/${order.id}/responses`, { headers: headers(master), data: { message: "Original synthetic offer" } })).status()).toBe(201);
    const conflict = page.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/responses`) && r.status() === 409);
    await card.getByRole("button", { name: "Надіслати пропозицію" }).click(); await conflict;
    await expect(card.getByText("Original synthetic offer")).toBeVisible(); await expect(card.getByRole("form")).toHaveCount(0);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(1);
  });
  test("browser removes a concurrently cancelled order after real POST 409 and GET", async ({ page, request }) => {
    const order = await create(request, "Browser closed conflict");
    await login(page, second); await page.getByRole("link", { name: /Заявки для майстра/ }).click();
    const card = page.getByRole("article", { name: order.title, exact: true }); await card.getByLabel("Ваша пропозиція").fill("Too late");
    expect((await request.delete(`${backend}/orders/${order.id}`, { headers: headers(client) })).status()).toBe(200);
    const conflict = page.waitForResponse((r) => r.url().endsWith(`/master/orders/${order.id}/responses`) && r.status() === 409);
    await card.getByRole("button", { name: "Надіслати пропозицію" }).click(); await conflict; await expect(card).toHaveCount(0);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(0);
  });
  test("mobile MASTER offer form fits 390×844 and has accessible text limits", async ({ page, request }) => {
    const order = await create(request, "Synthetic mobile offers");
    await page.setViewportSize({ width: 390, height: 844 }); await login(page, second); await page.getByRole("link", { name: /Заявки для майстра/ }).click();
    const form = page.getByRole("form", { name: `Пропозиція: ${order.title}`, exact: true });
    await form.getByLabel("Ваша пропозиція").fill("Synthetic offer ".repeat(100));
    await expect(form.getByLabel("Ваша пропозиція")).toHaveAttribute("maxlength", "2000");
    await form.getByRole("button", { name: "Надіслати пропозицію" }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
