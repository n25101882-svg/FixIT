import { useEffect, useState, type ReactNode } from "react";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";
import { safeStandardReturn, standardAuthPath } from "./standard-return";

const serviceId = "30000000-0000-4000-8000-000000000099";
const orderPath = `/orders/new/standard/${serviceId}`;
const master = { id: "master-profile", name: "Синтетичний виконавець", city: "Тестоград", category: "TECH_REPAIR", description: "Синтетичний профіль" };
const service = { id: serviceId, title: "Ремонт змішувача", description: "Синтетичний опис послуги", category: "PLUMBING", priceEstimate: "250.50", isActive: true, master };
const preview = { service, snapshot: "a".repeat(64) };
const order = { id: "synthetic-standard-order", serviceId, type: "STANDARD", status: "PENDING", title: service.title, description: "Синтетична проблема", city: master.city, category: "PLUMBING", priceAtOrder: "250.50", budget: null, masterProfileId: master.id, assignedMaster: master, createdAt: "2026-11-15T12:00:00.000Z" };
const client = { id: "synthetic-client", name: "Синтетичний клієнт", email: "synthetic-client@fixit.test", role: "CLIENT" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number, fields?: Record<string, string>) => json({ error: { message: `Помилка ${status}`, fields } }, status);
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth(); const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-standard-token"); setReady(true); }, [login]); return ready ? children : null;
}
function Location() { const location = useLocation(); return <span data-testid="location" hidden>{location.pathname + location.search}</span>; }
function show(path = orderPath, authenticated = true) {
  render(<MemoryRouter initialEntries={[path]}><AuthProvider>{authenticated ? <Session><App /><Location /></Session> : <><App /><Location /></>}</AuthProvider></MemoryRouter>);
}
async function fill() {
  await userEvent.type(await screen.findByLabelText("Опис проблеми"), order.description);
  await userEvent.click(screen.getByRole("checkbox", { name: /Підтверджую, що замовляю/ }));
}
afterEach(() => vi.unstubAllGlobals());

test.each([null, undefined, 123, {}, "https://evil.test", "//evil.test", "/dashboard", "/admin", "/orders/new/standard/invalid", orderPath + "?role=ADMIN", orderPath + "#hash", orderPath + "\n", orderPath + "/../admin", orderPath.replace("/orders", "\\orders")])("unsafe return context %# is rejected", (path) => { expect(safeStandardReturn(path)).toBeNull(); });
test("only the bounded STANDARD UUID path survives auth context encoding", () => {
  expect(safeStandardReturn(orderPath.toUpperCase().replace("/ORDERS/NEW/STANDARD/", "/orders/new/standard/"))).toBe(orderPath);
  const target = standardAuthPath("/login", orderPath); expect(new URL(target, "http://localhost").searchParams.get("returnTo")).toBe(orderPath);
  expect(standardAuthPath("/register", null)).toBe("/register");
});
test("guest booking redirects to login and returns to selected service after login", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ accessToken: "synthetic-standard-token", user: client })).mockResolvedValueOnce(json(preview)); vi.stubGlobal("fetch", mock); show(orderPath, false);
  expect(screen.getByTestId("location")).toHaveTextContent("/login?returnTo=");
  await userEvent.type(screen.getByLabelText("Email"), client.email); await userEvent.type(screen.getByLabelText("Пароль", { exact: true }), "Synthetic password for login");
  await userEvent.click(screen.getByRole("button", { name: "Увійти" }));
  expect(await screen.findByRole("form", { name: "STANDARD-замовлення" })).toBeInTheDocument(); expect(screen.getByTestId("location")).toHaveTextContent(orderPath);
  expect(mock.mock.calls[1]?.[0]).toMatch(new RegExp(`/orders/standard/${serviceId}$`)); expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-standard-token");
});
test("login/register links retain the safe selected service context", async () => {
  show(`/login?${new URLSearchParams({ returnTo: orderPath })}`, false);
  await userEvent.click(within(screen.getByRole("main")).getByRole("link", { name: "Створити акаунт" }));
  expect(screen.getByTestId("location")).toHaveTextContent("/register?returnTo=");
  await userEvent.click(within(screen.getByRole("main")).getByRole("link", { name: "Увійти" })); expect(screen.getByTestId("location")).toHaveTextContent("/login?returnTo=");
});
test("successful CLIENT registration retains selected service through the login redirect", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ user: client }, 201)));
  show(`/register?${new URLSearchParams({ returnTo: orderPath })}`, false);
  await userEvent.type(screen.getByLabelText("Ім’я"), client.name); await userEvent.type(screen.getByLabelText("Email"), client.email);
  await userEvent.type(screen.getByLabelText("Пароль"), "Synthetic password 123!"); await userEvent.type(screen.getByLabelText("Підтвердження пароля"), "Synthetic password 123!");
  await userEvent.click(screen.getByRole("button", { name: "Створити акаунт" })); expect(await screen.findByRole("status")).toHaveTextContent("Акаунт створено");
  expect(screen.getByTestId("location")).toHaveTextContent("/login?returnTo="); expect(screen.getByLabelText("Email")).toHaveValue(client.email);
});
test.each(["https://evil.test", "//evil.test", "/admin"])("login ignores injected returnTo %s", async (returnTo) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ accessToken: "synthetic-standard-token", user: client })).mockResolvedValueOnce(json({ user: client })); vi.stubGlobal("fetch", mock); show(`/login?${new URLSearchParams({ returnTo })}`, false);
  await userEvent.type(screen.getByLabelText("Email"), client.email); await userEvent.type(screen.getByLabelText("Пароль", { exact: true }), "Synthetic password"); await userEvent.click(screen.getByRole("button", { name: "Увійти" }));
  expect(await screen.findByText(client.email)).toBeInTheDocument(); expect(screen.getByTestId("location")).toHaveTextContent("/dashboard");
});
test("catalog and master cards route the concrete service into booking", async () => {
  const data = { services: [service], total: 1, page: 1, limit: 12, totalPages: 1 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(data)).mockResolvedValueOnce(json(preview))); show("/catalog");
  await userEvent.click(await screen.findByRole("button", { name: "Замовити послугу" })); expect(await screen.findByRole("form", { name: "STANDARD-замовлення" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent(orderPath);
});
test("public master page booking stays public until clicking the concrete service", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ master, services: [service], page: 1, limit: 12, total: 1, totalPages: 1 })));
  show("/masters/master-profile", false); await userEvent.click(await screen.findByRole("button", { name: "Замовити послугу" }));
  expect(screen.getByTestId("location")).toHaveTextContent("/login?returnTo="); expect(screen.queryByRole("form", { name: "STANDARD-замовлення" })).not.toBeInTheDocument();
});
test("preview shows service/executor/city/category/estimate and requires explicit city confirmation", async () => {
  const mock = vi.fn().mockResolvedValue(json(preview)); vi.stubGlobal("fetch", mock); show(); await screen.findByRole("form");
  expect(screen.getByRole("heading", { name: service.title })).toBeInTheDocument(); expect(screen.getByText(`Майстер: ${master.name}`)).toBeInTheDocument(); expect(screen.getByText("Сантехніка")).toBeInTheDocument(); expect(screen.getByText("Орієнтовна ціна: 250,50 грн")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled(); fireEvent.submit(screen.getByRole("form")); expect(mock).toHaveBeenCalledTimes(1);
});
test("201 submits only serviceId/problem/preview version, removes form and links to real history", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json({ order }, 201)).mockResolvedValueOnce(json({ orders: [order] })); vi.stubGlobal("fetch", mock); show(); await fill();
  await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" })); expect(await screen.findByRole("status")).toHaveTextContent("Замовлення створено"); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(JSON.parse(mock.mock.calls[1]?.[1].body)).toEqual({ serviceId, description: order.description, expectedSnapshot: preview.snapshot });
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/orders\/standard$/); expect(mock.mock.calls[1]?.[1].method).toBe("POST");
  await userEvent.click(screen.getByRole("link", { name: "Переглянути мої замовлення" })); const card = await screen.findByRole("article", { name: order.title });
  expect(card).toHaveTextContent("Очікує відповіді"); expect(card).toHaveTextContent("Ціна на момент замовлення: 250,50 грн"); expect(card).toHaveTextContent(`Виконавець: ${master.name}`); expect(within(card).queryByRole("button", { name: "Переглянути пропозиції" })).not.toBeInTheDocument();
});
test("optional null estimate is never shown as zero", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...preview, service: { ...service, priceEstimate: null } }))); show(); await screen.findByRole("form"); expect(screen.getByText("Ціна за домовленістю")).toBeInTheDocument(); expect(screen.queryByText(/0,00 грн/)).not.toBeInTheDocument();
});
test("whitespace description creates no POST and has a field error", async () => {
  const mock = vi.fn().mockResolvedValue(json(preview)); vi.stubGlobal("fetch", mock); show(); await userEvent.type(await screen.findByLabelText("Опис проблеми"), "   "); await userEvent.click(screen.getByRole("checkbox", { name: /Підтверджую/ }));
  await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" })); expect(screen.getByLabelText("Опис проблеми")).toHaveAttribute("aria-invalid", "true"); expect(mock).toHaveBeenCalledTimes(1);
});
test("400 field errors retain the description and city acknowledgement", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(400, { description: "Виправте опис проблеми" })); vi.stubGlobal("fetch", mock); show(); await fill();
  await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" })); expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 400");
  expect(screen.getByLabelText("Опис проблеми")).toHaveValue(order.description); expect(screen.getByLabelText("Опис проблеми")).toHaveAccessibleDescription(/Виправте опис проблеми/); expect(screen.getByRole("checkbox", { name: /Підтверджую/ })).toBeChecked();
});
test("pending POST blocks repeated clicks and confirmation changes", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockImplementationOnce(() => new Promise(() => {})); vi.stubGlobal("fetch", mock); show(); await fill();
  await userEvent.dblClick(screen.getByRole("button", { name: "Підтвердити замовлення" })); expect(screen.getByRole("button", { name: "Надсилаємо замовлення…" })).toBeDisabled(); expect(screen.getByRole("checkbox", { name: /Підтверджую/ })).toBeDisabled();
  fireEvent.submit(screen.getByRole("form")); expect(mock.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(1);
});
test("409 refreshes changed service/city, retains description and requires fresh acknowledgement", async () => {
  const changed = { service: { ...service, priceEstimate: "900.99", master: { ...master, city: "Нове місто" } }, snapshot: "b".repeat(64) };
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(409)).mockResolvedValueOnce(json(changed)); vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  expect(await screen.findByText("Орієнтовна ціна: 900,99 грн")).toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Помилка 409"); expect(screen.getByLabelText("Опис проблеми")).toHaveValue(order.description);
  expect(screen.getByRole("checkbox", { name: /Підтверджую.*Нове місто/ })).not.toBeChecked(); expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled(); expect(mock).toHaveBeenCalledTimes(3);
});
test("409 with failed preview retry blocks stale ordering and preserves both errors", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(409)).mockResolvedValueOnce(error(503)).mockResolvedValueOnce(json(preview)); vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  expect(await screen.findByText("Помилка 503")).toBeInTheDocument(); expect(screen.getByText("Помилка 409")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Оновити дані послуги" })); await waitFor(() => expect(screen.queryByText("Помилка 503")).not.toBeInTheDocument()); expect(screen.getByLabelText("Опис проблеми")).toHaveValue(order.description);
});
test.each(["network", "500", "malformed-success"])("ambiguous %s never retries POST or claims success before history review", async (kind) => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview));
  if (kind === "network") mock.mockRejectedValueOnce(new TypeError("offline")); else if (kind === "500") mock.mockResolvedValueOnce(error(500)); else mock.mockResolvedValueOnce(new Response("not-json", { status: 201 }));
  mock.mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json({ orders: [order, { ...order, id: "custom", type: "CUSTOM" }] })); vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  await screen.findByRole("region", { name: "Перевірка історії перед повтором" }); expect(screen.queryByText(/Замовлення створено/)).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Перевірити мою історію" })); expect(await screen.findByText("Номер: synthetic-standard-order")).toBeInTheDocument(); expect(screen.queryByText("Номер: custom")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Опис проблеми")).toHaveValue(order.description); expect(mock.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(1);
});
test("manual retry requires successful history GET and both explicit confirmations", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(503))
    .mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({ order }, 201)); vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  await userEvent.click(await screen.findByRole("button", { name: "Перевірити мою історію" })); await screen.findByText("Помилка 503"); expect(screen.queryByRole("checkbox", { name: /Я перевірив/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Перевірити мою історію" })); await screen.findByText("Замовлень цієї послуги в історії немає.");
  await userEvent.click(screen.getByRole("checkbox", { name: /Я перевірив/ })); expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: /Підтверджую/ })); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" })); expect(await screen.findByRole("status")).toHaveTextContent("Замовлення створено"); expect(mock.mock.calls.filter((c) => c[1].method === "POST")).toHaveLength(2);
});
test.each([401, 403])("history reconciliation %s uses logout or blocks ordering visibly", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(500)).mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(status));
  vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  await userEvent.click(await screen.findByRole("button", { name: "Перевірити мою історію" }));
  if (status === 401) expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  else { expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 403"); expect(screen.queryByRole("form")).not.toBeInTheDocument(); }
});
test.each([401, 403, 404])("preview %s logs out or blocks the form", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(error(status))); show();
  if (status === 401) expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  else { expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`); expect(screen.queryByRole("form")).not.toBeInTheDocument(); }
});
test.each([401, 403, 404])("POST %s never shows false success", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(error(status)); vi.stubGlobal("fetch", mock); show(); await fill(); await userEvent.click(screen.getByRole("button", { name: "Підтвердити замовлення" }));
  if (status === 401) expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  else { expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`); expect(screen.queryByText(/Замовлення створено/)).not.toBeInTheDocument(); if (status === 404) expect(screen.getByRole("button", { name: "Підтвердити замовлення" })).toBeDisabled(); else expect(screen.queryByRole("form")).not.toBeInTheDocument(); }
});
test("preview Loading/network Error can retry without losing the route", async () => {
  let resolve!: (value: Response) => void; const mock = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValueOnce(json(preview)); vi.stubGlobal("fetch", mock); show();
  expect(await screen.findByText("Завантажуємо дані послуги…")).toBeInTheDocument(); resolve(error(503)); await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Оновити дані послуги" })); expect(await screen.findByRole("form")).toBeInTheDocument(); expect(screen.getByTestId("location")).toHaveTextContent(orderPath);
});
test.each(["ACCEPTED", "DECLINED"])("MASTER acts on incoming STANDARD → %s without reload", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { ...client, role: "MASTER" } })).mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order: { ...order, status } })); vi.stubGlobal("fetch", mock); show("/dashboard");
  await userEvent.click(await screen.findByRole("button", { name: status === "ACCEPTED" ? "Прийняти" : "Відхилити" }));
  expect(await screen.findByText(status === "ACCEPTED" ? "Замовлення прийнято." : "Замовлення відхилено.")).toBeInTheDocument();
  const card = screen.getByRole("article", { name: order.title }); expect(within(card).queryByRole("button", { name: "Прийняти" })).not.toBeInTheDocument();
  if (status === "ACCEPTED") expect(within(card).getByRole("button", { name: "Розпочати роботу" })).toBeEnabled(); else expect(within(card).queryByRole("button")).not.toBeInTheDocument();
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({ status });
});
test("MASTER competing STANDARD decision gets 409 and synchronizes DECLINED", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { ...client, role: "MASTER" } })).mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(error(409)).mockResolvedValueOnce(json({ orders: [{ ...order, status: "DECLINED" }] })); vi.stubGlobal("fetch", mock); show("/dashboard");
  await userEvent.click(await screen.findByRole("button", { name: "Прийняти" })); expect(await screen.findByText("Відхилена")).toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Помилка 409"); expect(screen.queryByRole("button", { name: "Розпочати роботу" })).not.toBeInTheDocument();
});
test("pending MASTER acceptance disables the competing decline action", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { ...client, role: "MASTER" } })).mockResolvedValueOnce(json({ orders: [order] })).mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", mock); show("/dashboard"); await userEvent.dblClick(await screen.findByRole("button", { name: "Прийняти" }));
  expect(screen.getByRole("button", { name: "Відхилити" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Зберігаємо…" })).toBeDisabled(); expect(mock.mock.calls.filter((c) => c[1].method === "PATCH")).toHaveLength(1);
});
test.each(["IN_PROGRESS", "COMPLETED", "DECLINED", "CANCELLED"])("STANDARD %s remains in CLIENT history without cancellation", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ orders: [{ ...order, status, priceAtOrder: null }] }))); show("/orders"); const card = await screen.findByRole("article", { name: order.title });
  expect(card).toHaveTextContent("Замовлення послуги"); expect(card).toHaveTextContent("Ціна за домовленістю"); expect(within(card).queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument(); expect(within(card).queryByText("Бюджет не вказано")).not.toBeInTheDocument();
});
test.each(["PENDING", "ACCEPTED"])("CLIENT cancels STANDARD %s through the existing confirmation/DELETE", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [{ ...order, status }] })).mockResolvedValueOnce(json({ order: { ...order, status: "CANCELLED" } })); vi.stubGlobal("fetch", mock); show("/orders");
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" })); await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" })); expect(await screen.findByText("Скасована")).toBeInTheDocument(); expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument();
  expect(mock.mock.calls[1]?.[1].method).toBe("DELETE");
});
