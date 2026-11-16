import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const backend = "http://127.0.0.1:4100/api/v1"; const email = `${randomUUID()}@catalog-browser.fixit.test`;
const password = "Synthetic catalog browser passphrase!"; const city = `Місто ${randomUUID().slice(0, 8)}`;
let ownerId: string, token: string, profileId: string;
async function login(page: Page) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Увійти", exact: true }).click(); await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Профіль і послуги/ }).click(); await expect(page.getByRole("form", { name: "Мій профіль майстра" })).toBeVisible();
}
test.describe("@catalog real MASTER services and public discovery", () => {
  test.beforeAll(async ({ request }) => {
    const created = await request.post(`${backend}/auth/register`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password, passwordConfirmation: password, name: "Synthetic catalog master", role: "MASTER", city, category: "TECH_REPAIR", profileDescription: "Synthetic public profile", serviceTitle: "Synthetic initial service", serviceDescription: "Initial synthetic description" } });
    expect(created.status()).toBe(201); ownerId = (await created.json()).user.id;
    const loggedIn = await request.post(`${backend}/auth/login`, { headers: { Origin: "http://127.0.0.1:5174", "X-FixIT-CSRF": "1" }, data: { email, password } }); expect(loggedIn.status()).toBe(200); token = (await loggedIn.json()).accessToken;
    profileId = (await database.masterProfile.findUniqueOrThrow({ where: { userId: ownerId } })).id;
  });
  test.afterAll(async () => {
    if (ownerId) await database.$transaction(async (tx) => {
      await tx.service.deleteMany({ where: { masterProfile: { userId: ownerId } } });
      await tx.masterProfile.deleteMany({ where: { userId: ownerId } }); await tx.user.deleteMany({ where: { id: ownerId } });
    }); await database.$disconnect();
  });
  test("MASTER creates → guest filters/profile/F5 → hide → catalog excludes → reactivate restores", async ({ page, browser }) => {
    const context = await browser.newContext(); const masterPage = await context.newPage();
    try {
      await login(masterPage); const title = `Browser catalog ${randomUUID().slice(0, 8)}`;
      await masterPage.getByLabel("Назва послуги", { exact: true }).fill(title); await masterPage.getByLabel("Категорія послуги", { exact: true }).selectOption("PLUMBING");
      await masterPage.getByLabel("Опис послуги", { exact: true }).fill("Synthetic catalog description"); await masterPage.getByLabel(/Орієнтовна ціна/).fill("1500.25");
      let navigations = 0; masterPage.on("framenavigated", (frame) => { if (frame === masterPage.mainFrame()) navigations++; });
      const creation = masterPage.waitForResponse((r) => r.url().endsWith("/api/v1/master/services") && r.request().method() === "POST");
      await masterPage.getByRole("button", { name: "Створити послугу", exact: true }).click(); const createdHTTP = await creation; expect(createdHTTP.status()).toBe(201);
      const service = (await createdHTTP.json()).service; expect(service.priceEstimate).toBe("1500.25");
      const ownCard = masterPage.getByRole("article", { name: title, exact: true }); await expect(ownCard).toBeVisible();
      await page.goto("/catalog"); await page.getByRole("textbox", { name: "Пошук послуг", exact: true }).fill(title); await page.getByLabel("Місто", { exact: true }).fill(city);
      await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING"); await page.getByRole("button", { name: "Знайти послуги" }).click();
      const guestCard = page.getByRole("article", { name: title, exact: true }); await expect(guestCard).toBeVisible(); await expect(guestCard.getByText("1500,25 грн")).toBeVisible();
      await expect(guestCard.getByRole("button", { name: "Замовити послугу" })).toBeEnabled(); const catalogURL = page.url();
      await guestCard.getByRole("link", { name: /Майстер:/ }).click(); await expect(page).toHaveURL(new RegExp(`/masters/${profileId}$`)); await expect(page.getByText("Synthetic public profile")).toBeVisible();
      await page.reload(); await expect(page.getByRole("article", { name: title, exact: true })).toBeVisible(); // Public F5, no login.
      const hidden = masterPage.waitForResponse((r) => r.url().endsWith(`/master/services/${service.id}`) && r.request().method() === "PATCH");
      await ownCard.getByRole("button", { name: "Приховати" }).click(); expect((await hidden).status()).toBe(200); await expect(ownCard.getByText("Прихована", { exact: true })).toBeVisible();
      await page.reload(); await expect(page.getByRole("article", { name: title, exact: true })).toHaveCount(0);
      await page.goto(catalogURL); await expect(page.getByText(/Послуг за цими умовами поки немає/)).toBeVisible(); await page.reload(); await expect(page.getByText(/Послуг за цими умовами поки немає/)).toBeVisible();
      await ownCard.getByRole("button", { name: "Активувати" }).click(); await expect(ownCard.getByText("Активна", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Оновити каталог" }).click(); await expect(page.getByRole("article", { name: title, exact: true })).toBeVisible();
      const stored = await database.service.findUniqueOrThrow({ where: { id: service.id } }); expect(stored.isActive).toBe(true); expect(stored.priceEstimate?.toFixed(2)).toBe("1500.25");
      expect(await database.order.count({ where: { serviceId: service.id } })).toBe(0); expect(navigations).toBe(0);
    } finally { await context.close(); }
  });
  test("profile and service edits propagate to public catalog without changing independent categories or null price", async ({ page, request, browser }) => {
    const result = await request.post(`${backend}/master/services`, { headers: { Authorization: `Bearer ${token}` }, data: { title: "Browser editable service", category: "PLUMBING", description: "Synthetic editable", priceEstimate: "100.00" } }); expect(result.status()).toBe(201);
    const service = (await result.json()).service; await login(page);
    const nextCity = `Нове ${city}`; await page.getByLabel("Місто профілю").fill(nextCity); await page.getByLabel("Основна категорія").selectOption("OTHER"); await page.getByLabel("Опис профілю").fill("Updated synthetic public profile");
    await page.getByRole("button", { name: "Зберегти профіль" }).click(); await expect(page.getByText("Профіль оновлено.")).toBeVisible();
    await page.getByRole("article", { name: service.title, exact: true }).getByRole("button", { name: "Редагувати" }).click();
    const title = `Edited ${randomUUID().slice(0, 8)}`; await page.getByLabel("Назва послуги", { exact: true }).fill(title); await page.getByLabel(/Орієнтовна ціна/).fill(""); await page.getByRole("button", { name: "Зберегти послугу", exact: true }).click();
    await expect(page.getByRole("article", { name: title, exact: true }).getByText("Ціна не вказана")).toBeVisible();
    const context = await browser.newContext(); const guest = await context.newPage();
    try {
      await guest.goto(`/catalog?${new URLSearchParams({ city: nextCity, category: "PLUMBING", q: title })}`);
      await expect(guest.getByRole("article", { name: title, exact: true }).getByText("Ціна за домовленістю")).toBeVisible();
      await guest.getByRole("link", { name: /Майстер:/ }).first().click(); await expect(guest.getByText("Updated synthetic public profile")).toBeVisible();
      const stored = await database.service.findUniqueOrThrow({ where: { id: service.id } }); expect(stored.category).toBe("PLUMBING"); expect(stored.priceEstimate).toBeNull();
      expect((await database.masterProfile.findUniqueOrThrow({ where: { id: profileId } })).category).toBe("OTHER");
    } finally { await context.close(); }
  });
  test("public catalog and MASTER editor fit mobile 390×844; direct public URLs need no session", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/catalog"); await expect(page.getByRole("heading", { name: "Каталог послуг" })).toBeVisible();
    await page.getByRole("textbox", { name: "Пошук послуг", exact: true }).fill("Синтетичний пошук ".repeat(5));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(`/masters/${profileId}`); await page.reload(); await expect(page.getByRole("heading", { name: "Synthetic catalog master" })).toBeVisible();
    await login(page); await page.getByLabel("Назва послуги", { exact: true }).fill("Синтетична мобільна послуга ".repeat(5));
    await page.getByRole("button", { name: "Створити послугу" }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: "FixIT — головна" }).click();
    await expect(page).toHaveURL(/\/catalog$/);
    await page.getByRole("link", { name: /Мій простір/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });
});
