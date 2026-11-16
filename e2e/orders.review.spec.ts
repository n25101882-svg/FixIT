import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1";
const email = `${randomUUID()}@orders-review-browser.fixit.test`;
const password = "Synthetic review browser passphrase!";
let token: string;
test.beforeAll(async ({ request }) => {
  const registered = await request.post(`${backend}/auth/register`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: {
    email, name: "Синтетичний review-клієнт", role: "CLIENT", password, passwordConfirmation: password,
  } });
  expect(registered.status()).toBe(201);
  const login = await request.post(`${backend}/auth/login`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password } });
  expect(login.status()).toBe(200);
  token = (await login.json()).accessToken;
});
test.afterAll(async () => {
  await database.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { client: { email } } });
    await tx.user.deleteMany({ where: { email } });
  });
  await database.$disconnect();
});
async function fixture(request: APIRequestContext, label: string) {
  const response = await request.post(`${backend}/orders`, { headers: { Authorization: `Bearer ${token}` }, data: {
    title: `Review ${label} ${randomUUID()}`, description: "Синтетична проблема для review-тесту", city: "Тестоград", category: "OTHER",
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).order as { id: string; title: string };
}
async function open(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Мої заявки" }).click();
}

test("REVIEW-01: keyboard dialog traps focus; No, Escape and Close send no request; Yes sends one DELETE", async ({ page, request }) => {
  const order = await fixture(request, "keyboard");
  await open(page);
  const trigger = page.getByRole("article", { name: order.title }).getByRole("button", { name: "Скасувати заявку" });
  await expect(trigger).toBeEnabled();
  const traffic: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/orders")) traffic.push(r.method()); });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Скасувати заявку?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Ні, залишити" })).toBeFocused();
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole("button", { name: "Ні, залишити" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter"); await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрити діалог" }).click();
  await expect(dialog).toHaveCount(0);
  expect(traffic).toEqual([]);
  expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OPEN");
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Ні, залишити" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Так, скасувати" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article", { name: order.title }).getByText("Скасована", { exact: true })).toBeVisible();
  expect(traffic).toEqual(["DELETE"]);
  const stored = await database.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(stored.statusHistory).toEqual([expect.objectContaining({ status: "OPEN" }), expect.objectContaining({ status: "CANCELLED" })]);
});

test("REVIEW-02: a real competing cancellation produces 409 and automatic PostgreSQL resynchronization", async ({ page, request }) => {
  const order = await fixture(request, "conflict");
  await open(page);
  const card = page.getByRole("article", { name: order.title });
  await expect(card.getByText("Відкрита", { exact: true })).toBeVisible();
  expect((await request.delete(`${backend}/orders/${order.id}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  const read = page.waitForResponse((r) => r.url() === `${backend}/orders` && r.request().method() === "GET" && r.status() === 200);
  const conflict = page.waitForResponse((r) => r.url() === `${backend}/orders/${order.id}` && r.status() === 409);
  await card.getByRole("button", { name: "Скасувати заявку" }).click();
  await page.getByRole("button", { name: "Так, скасувати" }).click();
  await conflict;
  expect((await (await read).json()).orders.find((row: { id: string }) => row.id === order.id).status).toBe("CANCELLED");
  await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Поточний стан заявки");
  await expect(card.getByRole("button", { name: "Скасувати заявку" })).toHaveCount(0);
  expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).statusHistory).toHaveLength(2);
});

test("REVIEW-02: failed conflict GET retains both errors and disables the stale button until retry", async ({ page, request }) => {
  const order = await fixture(request, "failed-sync");
  await open(page);
  const card = page.getByRole("article", { name: order.title });
  await expect(card.getByText("Відкрита", { exact: true })).toBeVisible();
  expect((await request.delete(`${backend}/orders/${order.id}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  let fail = true;
  await page.route(`${backend}/orders`, async (route) => {
    if (fail && route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: { message: "Історія тимчасово недоступна." } } });
    else await route.continue();
  });
  await card.getByRole("button", { name: "Скасувати заявку" }).click();
  await page.getByRole("button", { name: "Так, скасувати" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Поточний стан заявки" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Історія тимчасово недоступна" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Скасувати заявку" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Створити заявку" })).toBeEnabled();
  fail = false;
  await page.getByRole("button", { name: "Спробувати ще раз" }).click();
  await expect(card.getByText("Скасована", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Поточний стан заявки");
});

for (const outage of ["503", "network"]) {
  test(`FIX-18: history ${outage} keeps CLIENT form usable with real POST and PostgreSQL`, async ({ page }) => {
    let fail = true;
    await page.route(`${backend}/orders`, async (route) => {
      if (fail && route.request().method() === "GET") {
        if (outage === "network") await route.abort("failed");
        else await route.fulfill({ status: 503, json: { error: { message: "Історія тимчасово недоступна." } } });
      } else await route.continue();
    });
    await open(page);
    await expect(page.getByRole("button", { name: "Спробувати ще раз" })).toBeVisible();
    const title = `Review outage ${outage} ${randomUUID()}`;
    await page.getByLabel("Назва проблеми", { exact: true }).fill(title);
    await page.getByLabel("Опис проблеми", { exact: true }).fill("Синтетична заявка під час збою історії");
    await page.getByLabel("Місто", { exact: true }).fill("Тестоград");
    await page.getByLabel("Категорія", { exact: true }).selectOption("OTHER");
    const posted = page.waitForResponse((r) => r.url() === `${backend}/orders` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Створити заявку" }).click();
    const response = await posted;
    expect(response.status()).toBe(201);
    const order = (await response.json()).order;
    expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).title).toBe(title);
    await expect(page.getByRole("article", { name: title })).toBeVisible();
    await page.getByLabel("Назва проблеми", { exact: true }).fill("Незавершена чернетка");
    fail = false;
    const read = page.waitForResponse((r) => r.url() === `${backend}/orders` && r.request().method() === "GET" && r.status() === 200);
    await page.getByRole("button", { name: "Спробувати ще раз" }).click();
    await read;
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("Назва проблеми", { exact: true })).toHaveValue("Незавершена чернетка");
  });
}
