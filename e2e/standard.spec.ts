import { randomUUID } from "node:crypto";
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1"; const suffix = `@${randomUUID()}.standard-browser.fixit.test`;
const city = `Місто ${randomUUID().slice(0, 8)}`; const password = "Synthetic STANDARD browser passphrase!";
type Account = { id: string; email: string; token: string }; let client: Account, master: Account, profileId: string;
const headers = (actor: Account) => ({ Authorization: `Bearer ${actor.token}` });
async function account(request: APIRequestContext, name: string, role: "CLIENT" | "MASTER"): Promise<Account> {
  const email = name + suffix; const response = await request.post(`${backend}/auth/register`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password, passwordConfirmation: password, name: `Synthetic ${name}`, role,
    ...(role === "MASTER" ? { city, category: "TECH_REPAIR", profileDescription: "Synthetic profile", serviceTitle: "Synthetic initial service", serviceDescription: "Synthetic initial description" } : {}) } });
  expect(response.status()).toBe(201); const login = await request.post(`${backend}/auth/login`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password } }); expect(login.status()).toBe(200);
  return { id: (await response.json()).user.id, email, token: (await login.json()).accessToken };
}
async function login(page: Page, actor: Account, inPlace = false) {
  await page.context().request.post(`${backend}/auth/logout`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: {} });
  if (!inPlace) await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(actor.email); await page.getByLabel("Пароль", { exact: true }).fill(password);
  const loggedIn = page.waitForResponse((response) => response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  expect((await loggedIn).status()).toBe(200);
  await expect(page).toHaveURL(inPlace ? /\/orders\/new\/standard\/[0-9a-f-]+$/ : /\/dashboard$/);
  if (!inPlace) await expect(page.getByText(actor.email, { exact: true })).toBeVisible();
}
async function service(request: APIRequestContext, label: string, priceEstimate: string | null = "450.25") {
  const response = await request.post(`${backend}/master/services`, { headers: headers(master), data: { title: `${label} ${randomUUID().slice(0, 8)}`, category: "PLUMBING", description: "Synthetic STANDARD service", priceEstimate } });
  expect(response.status()).toBe(201); return (await response.json()).service;
}
async function place(request: APIRequestContext, serviceId: string) {
  const response = await request.post(`${backend}/orders/standard`, { headers: headers(client), data: { serviceId, description: "Synthetic problem, district only" } });
  expect(response.status()).toBe(201); return (await response.json()).order;
}
test.describe("@standard real service booking and execution", () => {
  test.beforeAll(async ({ request }) => { client = await account(request, "client", "CLIENT"); master = await account(request, "master", "MASTER"); profileId = (await database.masterProfile.findUniqueOrThrow({ where: { userId: master.id } })).id; });
  test.afterAll(async () => {
    // This cohort has only STANDARD orders, no selected-response cycles.
    if (client?.id && master?.id) await database.$transaction(async (tx) => {
      await tx.order.deleteMany({ where: { clientId: client.id } }); await tx.service.deleteMany({ where: { masterProfile: { userId: master.id } } });
      await tx.masterProfile.deleteMany({ where: { userId: master.id } }); await tx.user.deleteMany({ where: { id: { in: [client.id, master.id] } } });
    }); await database.$disconnect();
  });
  test("guest catalog → safe login return → CLIENT PENDING → MASTER accepts/executes → CLIENT COMPLETED with original snapshot", async ({ page, browser, request }) => {
    const svc = await service(request, "Full STANDARD");
    await page.goto(`/catalog?${new URLSearchParams({ q: svc.title })}`); await page.getByRole("article", { name: svc.title, exact: true }).getByRole("button", { name: "Замовити послугу" }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=/); await login(page, client, true); await expect(page).toHaveURL(new RegExp(`/orders/new/standard/${svc.id}$`));
    await expect(page.getByRole("heading", { name: svc.title })).toBeVisible(); await expect(page.getByText(city, { exact: true })).toBeVisible(); await expect(page.getByText("Орієнтовна ціна: 450,25 грн")).toBeVisible();
    await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic real browser STANDARD problem"); await expect(page.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /Підтверджую, що замовляю/ }).check();
    const creation = page.waitForResponse((r) => r.url().endsWith("/api/v1/orders/standard") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Підтвердити замовлення" }).click(); const createdHTTP = await creation; expect(createdHTTP.status()).toBe(201); const order = (await createdHTTP.json()).order;
    expect(Object.keys(createdHTTP.request().postDataJSON()).sort()).toEqual(["description", "expectedSnapshot", "serviceId"]);
    expect(order).toMatchObject({ type: "STANDARD", status: "PENDING", clientId: client.id, masterProfileId: profileId, serviceId: svc.id, city, priceAtOrder: "450.25" });
    await page.getByRole("link", { name: "Переглянути мої замовлення" }).click(); const clientCard = page.getByRole("article", { name: svc.title, exact: true }); await expect(clientCard.getByText("Очікує відповіді", { exact: true })).toBeVisible();
    // Real subsequent catalog edits must not rewrite the confirmed order.
    expect((await request.patch(`${backend}/master/services/${svc.id}`, { headers: headers(master), data: { title: `Changed ${svc.title}`, category: "OTHER", priceEstimate: "999.99" } })).status()).toBe(200);
    const context = await browser.newContext(); const masterPage = await context.newPage();
    try {
      await login(masterPage, master); const card = masterPage.getByRole("article", { name: svc.title, exact: true });
      await card.getByRole("button", { name: "Прийняти", exact: true }).click(); await expect(card.getByRole("button", { name: "Розпочати роботу" })).toBeVisible();
      await page.getByRole("button", { name: "Оновити", exact: true }).click(); await expect(clientCard.getByText("Прийнята", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Розпочати роботу" }).click(); await expect(card.getByRole("button", { name: "Завершити роботу" })).toBeVisible();
      await page.getByRole("button", { name: "Оновити", exact: true }).click(); await expect(clientCard.getByText("У роботі", { exact: true })).toBeVisible(); await expect(clientCard.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0);
      expect((await request.delete(`${backend}/orders/${order.id}`, { headers: headers(client) })).status()).toBe(409);
      await card.getByRole("button", { name: "Завершити роботу" }).click(); await expect(card.getByText("Завершена", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Оновити", exact: true }).click(); await expect(clientCard.getByText("Завершена", { exact: true })).toBeVisible(); await expect(clientCard.getByText("Ціна на момент замовлення: 450,25 грн", { exact: true })).toBeVisible();
      const row = await database.order.findUniqueOrThrow({ where: { id: order.id } }); expect(row.title).toBe(svc.title); expect(row.category).toBe("PLUMBING"); expect(row.priceAtOrder?.toFixed(2)).toBe("450.25");
      const history = row.statusHistory as { status: string; actorUserId: string }[]; expect(history.map((event) => event.status)).toEqual(["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]); expect(history[0]?.actorUserId).toBe(client.id); expect(history.slice(1).every((event) => event.actorUserId === master.id)).toBe(true);
    } finally { await context.close(); }
  });
  test("MASTER declines incoming STANDARD and CLIENT sees retained DECLINED/null-price history", async ({ page, browser, request }) => {
    const svc = await service(request, "Declined STANDARD", null); const order = await place(request, svc.id); await login(page, master);
    const card = page.getByRole("article", { name: svc.title, exact: true }); await card.getByRole("button", { name: "Відхилити", exact: true }).click(); await expect(card.getByText("Відхилена", { exact: true })).toBeVisible(); await expect(card.getByRole("button")).toHaveCount(0);
    const context = await browser.newContext(); const clientPage = await context.newPage();
    try {
      await login(clientPage, client); await clientPage.getByRole("link", { name: "Мої заявки" }).click(); const history = clientPage.getByRole("article", { name: svc.title, exact: true });
      await expect(history.getByText("Відхилена", { exact: true })).toBeVisible(); await expect(history.getByText("Ціна за домовленістю", { exact: true })).toBeVisible(); await expect(history.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0);
      expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).statusHistory).toHaveLength(2);
    } finally { await context.close(); }
  });
  test("CLIENT logically cancels a pending STANDARD with confirmation and retained history", async ({ page, request }) => {
    const svc = await service(request, "Cancelled STANDARD"); const order = await place(request, svc.id); await login(page, client); await page.getByRole("link", { name: "Мої заявки" }).click();
    const card = page.getByRole("article", { name: svc.title, exact: true }); await card.getByRole("button", { name: "Скасувати заявку" }).click(); await page.getByRole("button", { name: "Так, скасувати", exact: true }).click(); await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
    expect((await request.delete(`${backend}/orders/${order.id}`, { headers: headers(client) })).status()).toBe(409);
    const row = await database.order.findUniqueOrThrow({ where: { id: order.id } }); expect((row.statusHistory as { status: string }[]).map((event) => event.status)).toEqual(["PENDING", "CANCELLED"]); expect(row.serviceId).toBe(svc.id);
  });
  test("stale preview and old URL cannot order a hidden service", async ({ page, request }) => {
    const svc = await service(request, "Hidden STANDARD"); await login(page, client);
    await page.getByRole("link", { name: "Каталог", exact: true }).click(); await page.getByRole("textbox", { name: "Пошук послуг", exact: true }).fill(svc.title); await page.getByRole("button", { name: "Знайти послуги" }).click();
    await page.getByRole("article", { name: svc.title, exact: true }).getByRole("button", { name: "Замовити послугу" }).click(); await expect(page.getByRole("form", { name: "STANDARD-замовлення" })).toBeVisible();
    expect((await request.patch(`${backend}/master/services/${svc.id}`, { headers: headers(master), data: { isActive: false } })).status()).toBe(200);
    await page.getByLabel("Опис проблеми", { exact: true }).fill("Synthetic stale service problem"); await page.getByRole("checkbox", { name: /Підтверджую, що замовляю/ }).check();
    const conflict = page.waitForResponse((r) => r.url().endsWith("/orders/standard") && r.request().method() === "POST"); await page.getByRole("button", { name: "Підтвердити замовлення" }).click(); expect((await conflict).status()).toBe(409);
    await expect(page.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled(); await expect(page.getByText(/Послуга недоступна/)).toBeVisible(); expect(await database.order.count({ where: { serviceId: svc.id } })).toBe(0);
    await page.reload(); await expect(page).toHaveURL(new RegExp(`/orders/new/standard/${svc.id}$`));
    await expect(page.getByText(/Послуга недоступна/)).toBeVisible(); await expect(page.getByRole("form", { name: "STANDARD-замовлення" })).toHaveCount(0);
  });
});
