import { randomUUID } from "node:crypto";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1";
const suffix = `@${randomUUID()}.orders-browser.fixit.test`;
const password = "Synthetic orders browser passphrase!";
let a: { id: string; email: string; token: string }, b: typeof a, master: typeof a;
async function account(request: APIRequestContext, name: string, role = "CLIENT") {
  const email = name + suffix;
  const response = await request.post(`${backend}/auth/register`, { data: {
    email, name: "Синтетичний користувач", password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city: "Тестоград", category: "OTHER", profileDescription: "Синтетичний профіль", serviceTitle: "Синтетична послуга", serviceDescription: "Опис синтетичної послуги" } : {}),
  } });
  expect(response.status()).toBe(201);
  const user = (await response.json()).user;
  const login = await request.post(`${backend}/auth/login`, { data: { email, password } });
  expect(login.status()).toBe(200);
  return { id: user.id as string, email, token: (await login.json()).accessToken as string };
}
async function login(page: Page, user: typeof a) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
}
test.beforeAll(async ({ request }) => {
  a = await account(request, "client-a"); b = await account(request, "client-b"); master = await account(request, "master", "MASTER");
});
test.afterAll(async () => {
  const owner = { email: { endsWith: suffix } };
  await database.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { client: owner } });
    await tx.service.deleteMany({ where: { masterProfile: { user: owner } } });
    await tx.masterProfile.deleteMany({ where: { user: owner } });
    await tx.user.deleteMany({ where: owner });
  });
  await database.$disconnect();
});

test("guest /orders redirects to login; anonymous API requests are 401", async ({ page, request }) => {
  await page.goto("/orders");
  await expect(page).toHaveURL(/\/login$/);
  expect((await request.get(`${backend}/orders`)).status()).toBe(401);
  expect((await request.post(`${backend}/orders`, { data: {} })).status()).toBe(401);
  expect((await request.delete(`${backend}/orders/${randomUUID()}`)).status()).toBe(401);
});

test("React → JWT API → PostgreSQL → React creates and logically cancels CUSTOM without reload", async ({ page, request }) => {
  await login(page, a);
  const listResponse = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "GET" && r.status() === 200);
  await page.getByRole("link", { name: "Мої заявки" }).click();
  expect((await (await listResponse).json()).orders).toEqual([]);
  await expect(page.getByText(/У вас поки немає заявок/)).toBeVisible();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  const title = "Синтетична проблема з водою";
  await page.getByLabel("Назва проблеми", { exact: true }).fill(title);
  await page.getByLabel("Опис проблеми", { exact: true }).fill("Синтетичний опис без персональних даних.");
  await page.getByLabel("Місто", { exact: true }).fill("Тестоград");
  await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING");
  await page.getByLabel(/Бюджет, грн/).fill("1250.50");
  const createdResponse = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Створити заявку", exact: true }).click();
  const createdHTTP = await createdResponse;
  expect(createdHTTP.status()).toBe(201);
  const created = (await createdHTTP.json()).order;
  expect(created).toMatchObject({ clientId: a.id, type: "CUSTOM", status: "OPEN", budget: "1250.50" });
  expect(Object.keys(createdHTTP.request().postDataJSON()).sort()).toEqual(["budget", "category", "city", "description", "title"]);
  const card = page.getByRole("article", { name: title });
  await expect(card.getByText("Відкрита", { exact: true })).toBeVisible();
  await expect(card.getByText("1250,50 грн")).toBeVisible();
  const before = await database.order.findUniqueOrThrow({ where: { id: created.id } });
  expect(before.budget?.toFixed(2)).toBe("1250.50");
  expect(before.clientId).toBe(a.id);
  expect(before.statusHistory).toEqual([expect.objectContaining({ status: "OPEN", actorUserId: a.id, source: "database" })]);
  expect((await request.delete(`${backend}/orders/${created.id}`, { headers: { Authorization: `Bearer ${b.token}` } })).status()).toBe(403);
  const cancelledResponse = page.waitForResponse((r) => r.url().endsWith(`/orders/${created.id}`) && r.request().method() === "DELETE");
  await card.getByRole("button", { name: "Скасувати заявку" }).click();
  await expect(page.getByRole("dialog", { name: "Скасувати заявку?" })).toBeVisible();
  await page.getByRole("button", { name: "Так, скасувати", exact: true }).click();
  expect((await cancelledResponse).status()).toBe(200);
  await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0);
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "GET" && r.status() === 200);
  await page.getByRole("button", { name: "Оновити", exact: true }).click();
  expect((await (await refreshed).json()).orders.find((row: { id: string }) => row.id === created.id).status).toBe("CANCELLED");
  await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
  expect(navigations).toBe(0);
  const after = await database.order.findUniqueOrThrow({ where: { id: created.id } });
  expect(after.status).toBe("CANCELLED");
  expect(after.title).toBe(before.title);
  expect(after.createdAt).toEqual(before.createdAt);
  expect(after.statusHistory).toEqual([...(before.statusHistory as object[]), expect.objectContaining({ status: "CANCELLED", actorUserId: a.id, source: "database" })]);
  expect((await request.delete(`${backend}/orders/${created.id}`, { headers: { Authorization: `Bearer ${a.token}` } })).status()).toBe(409);
  expect(await database.order.findUniqueOrThrow({ where: { id: created.id } })).toEqual(after);
  const list = await request.get(`${backend}/orders`, { headers: { Authorization: `Bearer ${a.token}` } });
  expect(list.status()).toBe(200);
  expect((await list.json()).orders.find((row: { id: string }) => row.id === created.id).status).toBe("CANCELLED");
});

test("another CLIENT sees only own orders and can leave budget unset", async ({ page, request }) => {
  await login(page, b);
  await page.getByRole("link", { name: "Мої заявки" }).click();
  await expect(page.getByText(/У вас поки немає заявок/)).toBeVisible();
  const title = "Синтетична електрична проблема";
  await page.getByLabel("Назва проблеми", { exact: true }).fill(title);
  await page.getByLabel("Опис проблеми", { exact: true }).fill("Синтетична заявка другого клієнта.");
  await page.getByLabel("Місто", { exact: true }).fill("Прикладськ");
  await page.getByLabel("Категорія", { exact: true }).selectOption("ELECTRICAL");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Створити заявку", exact: true }).click();
  const http = await response;
  expect(http.status()).toBe(201);
  expect(http.request().postDataJSON()).not.toHaveProperty("budget");
  const created = (await http.json()).order;
  expect(created.budget).toBeNull();
  expect((await database.order.findUniqueOrThrow({ where: { id: created.id } })).clientId).toBe(b.id);
  await expect(page.getByRole("article", { name: title })).toBeVisible();
  const other = await request.get(`${backend}/orders`, { headers: { Authorization: `Bearer ${a.token}` } });
  expect((await other.json()).orders.some((row: { id: string }) => row.id === created.id)).toBe(false);
});

test("MASTER dashboard has no CLIENT orders link and API refuses creation", async ({ page, request }) => {
  await login(page, master);
  await expect(page.getByRole("link", { name: "Мої заявки" })).toHaveCount(0);
  expect((await request.get(`${backend}/orders`, { headers: { Authorization: `Bearer ${master.token}` } })).status()).toBe(403);
  expect((await request.post(`${backend}/orders`, { headers: { Authorization: `Bearer ${master.token}` }, data: {
    title: "Forbidden", description: "Synthetic", city: "Test city", category: "OTHER",
  } })).status()).toBe(403);
});

test("mobile orders form and cards fit 390×844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, a);
  await page.getByRole("link", { name: "Мої заявки" }).click();
  await page.getByLabel("Назва проблеми", { exact: true }).fill("Синтетична мобільна заявка ".repeat(5));
  await page.getByRole("button", { name: "Створити заявку", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Створити заявку", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
