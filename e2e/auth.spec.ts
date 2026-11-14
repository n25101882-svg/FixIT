import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createDatabaseClient } from "../src/database/client.js";
import { requireLocalTestDatabase } from "../src/config.js";

const database = createDatabaseClient(
  requireLocalTestDatabase(process.env.TEST_DATABASE_URL),
);
const suffix = `@${randomUUID()}.browser-tests.fixit.test`;
const password = "Synthetic browser passphrase 2026!";

test.afterAll(async () => {
  const owner = { email: { endsWith: suffix } };
  await database.$transaction(async (tx) => {
    await tx.service.deleteMany({ where: { masterProfile: { user: owner } } });
    await tx.masterProfile.deleteMany({ where: { user: owner } });
    await tx.user.deleteMany({ where: owner });
  });
  await database.$disconnect();
});

test("protected dashboard redirects unauthenticated visitors", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: /Раді бачити знову/ }),
  ).toBeVisible();
});

for (const role of ["CLIENT", "MASTER"] as const) {
  test(`real ${role} registration, login, profile and logout`, async ({
    page,
  }) => {
    const email = role.toLowerCase() + suffix;
    const name =
      role === "CLIENT" ? "Синтетичний клієнт" : "Синтетичний майстер";
    await page.goto("/register");
    await page.getByLabel("Ім’я", { exact: true }).fill(name);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByLabel("Підтвердження пароля", { exact: true }).fill(password);
    if (role === "MASTER") {
      await page.getByRole("radio", { name: /Майстер/ }).check();
      await page.getByLabel("Місто", { exact: true }).fill("Синтетичне місто");
      await page.getByLabel("Категорія", { exact: true }).selectOption("PLUMBING");
      await page.getByLabel("Опис профілю", { exact: true }).fill("Синтетичний досвід майстра");
      await page.getByLabel("Назва першої послуги", { exact: true }).fill("Перша синтетична послуга");
      await page.getByLabel("Опис першої послуги", { exact: true }).fill("Синтетичний опис послуги");
      await page.getByLabel(/Орієнтовна ціна/).fill("250.50");
    } else {
      await expect(page.getByLabel("Місто", { exact: true })).toHaveCount(0);
    }
    await page
      .getByRole("button", { name: "Створити акаунт", exact: true })
      .click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("status")).toContainText("Акаунт створено");
    const stored = await database.user.findUniqueOrThrow({
      where: { email }, include: { masterProfile: { include: { services: true } } },
    });
    if (role === "MASTER") {
      expect(stored.masterProfile?.city).toBe("Синтетичне місто");
      expect(stored.masterProfile?.category).toBe("PLUMBING");
      expect(stored.masterProfile?.services).toHaveLength(1);
      expect(stored.masterProfile?.services[0]?.category).toBe("PLUMBING");
      expect(stored.masterProfile?.services[0]?.priceEstimate?.toFixed(2)).toBe("250.50");
    } else expect(stored.masterProfile).toBeNull();
    await page
      .getByLabel("Пароль", { exact: true })
      .fill("Wrong browser password");
    await page.getByRole("button", { name: "Увійти", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Неправильний email або пароль",
    );
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    const me = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/users/me") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Увійти", exact: true }).click();
    const profile = await (await me).json();
    expect(Object.keys(profile.user).sort()).toEqual([
      "email",
      "id",
      "name",
      "role",
    ]);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByText(role, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ local: 0, session: 0 });
    await page.getByRole("button", { name: /Вийти/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });
}

test("registration displays a duplicate email error", async ({
  page,
  request,
}) => {
  const email = "duplicate" + suffix;
  const created = await request.post(
    "http://127.0.0.1:4100/api/v1/auth/register",
    { data: { email, name: "Тестовий користувач", password, passwordConfirmation: password } },
  );
  expect(created.status()).toBe(201);
  await page.goto("/register");
  await page.getByLabel("Ім’я", { exact: true }).fill("Тестовий користувач");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByLabel("Підтвердження пароля", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Створити акаунт", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Цей email уже зареєстрований",
  );
});

test("mobile auth layout fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { name: /Будьмо знайомі/ }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Майстер/ }).check();
  await expect(page.getByLabel("Опис першої послуги", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Створити акаунт", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Створити акаунт", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
