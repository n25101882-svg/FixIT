import { useEffect, useState, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";

const order = { id: "synthetic-order", type: "CUSTOM", title: "Синтетична проблема", description: "Синтетичний опис",
  city: "Тестоград", category: "PLUMBING", budget: "250.50", status: "OPEN", createdAt: "2026-11-14T10:00:00.000Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-orders-token"); setReady(true); }, [login]);
  return ready ? children : null;
}
function show(authenticated = true) {
  render(<MemoryRouter initialEntries={["/orders"]}><AuthProvider recoverSession={false}>
    {authenticated ? <Session><App /></Session> : <App />}
  </AuthProvider></MemoryRouter>);
}
async function fill(budget?: string) {
  const actions = userEvent.setup();
  await screen.findByRole("heading", { name: "Нова заявка" });
  await actions.type(screen.getByLabelText("Назва проблеми"), order.title);
  await actions.type(screen.getByLabelText("Опис проблеми"), order.description);
  await actions.type(screen.getByLabelText("Місто"), order.city);
  await actions.selectOptions(screen.getByLabelText("Категорія"), order.category);
  if (budget) await actions.type(screen.getByLabelText(/Бюджет, грн/), budget);
  return actions;
}
afterEach(() => vi.unstubAllGlobals());

test("/orders is protected by the existing login route", () => {
  show(false);
  expect(screen.getByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
test("displays Loading until the real list request completes", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  show();
  expect(await screen.findByRole("status")).toHaveTextContent("Завантажуємо заявки");
});
test("200 empty list displays Empty and a creation form", async () => {
  const mock = vi.fn().mockResolvedValue(json({ orders: [] }));
  vi.stubGlobal("fetch", mock); show();
  expect(await screen.findByText(/У вас поки немає заявок/)).toBeInTheDocument();
  expect(screen.getByRole("form", { name: "Нова заявка" })).toBeInTheDocument();
  expect(mock.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer synthetic-orders-token");
});
test("shows server orders, status, description and exact budget", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ orders: [order] })));
  show();
  const card = await screen.findByRole("article", { name: order.title });
  expect(within(card).getByText("Відкрита")).toBeInTheDocument();
  expect(within(card).getByText(order.description)).toBeInTheDocument();
  expect(within(card).getByText("250,50 грн")).toBeInTheDocument();
});
test("creates with JWT and an exact budget string, then updates the list without reloading", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({ order }, 201));
  vi.stubGlobal("fetch", mock); show();
  const actions = await fill("250.50");
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Заявку створено");
  expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[1]?.[1].method).toBe("POST");
  expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-orders-token");
  expect(JSON.parse(mock.mock.calls[1]?.[1].body)).toEqual({ title: order.title, description: order.description, city: order.city, category: order.category, budget: "250.50" });
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue("");
});
test("omits an empty optional budget from the POST payload", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({ order: { ...order, budget: null } }, 201));
  vi.stubGlobal("fetch", mock); show();
  const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  await screen.findByRole("article");
  expect(JSON.parse(mock.mock.calls[1]?.[1].body)).not.toHaveProperty("budget");
  expect(screen.getByText("Бюджет не вказано")).toBeInTheDocument();
});
test("DELETE keeps the card, changes status to Cancelled and removes its cancel button", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order: { ...order, status: "CANCELLED" } }));
  vi.stubGlobal("fetch", mock); show();
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Заявку скасовано");
  expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument();
  expect(screen.getByText("Скасована")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/orders\/synthetic-order$/);
  expect(mock.mock.calls[1]?.[1].method).toBe("DELETE");
  expect(mock.mock.calls[1]?.[1].body).toBeUndefined();
  expect(mock).toHaveBeenCalledTimes(2);
});
test("409 cancellation displays Error and automatically synchronizes the card", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ error: { message: "Поточний стан не дозволяє скасування." } }, 409))
    .mockResolvedValueOnce(json({ orders: [{ ...order, status: "CANCELLED" }] })));
  show();
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Поточний стан не дозволяє скасування");
  expect(screen.queryByText("Заявку скасовано.")).not.toBeInTheDocument();
  await screen.findByText("Скасована");
  expect(screen.getByRole("alert")).toHaveTextContent("Поточний стан не дозволяє скасування");
  expect(screen.queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
});
test("list errors support retry", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ error: { message: "Не вдалося завантажити заявки." } }, 500)).mockResolvedValueOnce(json({ orders: [] }));
  vi.stubGlobal("fetch", mock); show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Не вдалося завантажити заявки");
  await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
  expect(await screen.findByText(/У вас поки немає заявок/)).toBeInTheDocument();
});
test("401 clears the session and returns to login", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Unauthorized" } }, 401)));
  show();
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Сесія завершилася");
});
test("403 hides the CLIENT form and shows safe access feedback", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Заявки доступні лише клієнтам." } }, 403)));
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("лише клієнтам");
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "До кабінету" })).toBeInTheDocument();
});
test("POST field errors retain the form input and do not invent a successful order", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({ error: { message: "Перевірте поля заявки.", fields: { city: "Вкажіть коректне місто." } } }, 400)));
  show(); const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте поля заявки");
  expect(screen.getByLabelText("Місто")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue(order.title);
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
test("network mutation failure is shown without losing form data", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockRejectedValueOnce(new TypeError("Network failed")));
  show(); const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Не вдалося з’єднатися");
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue(order.title);
});
test("pending creation disables duplicate submissions", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((complete) => { resolve = complete; });
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockReturnValueOnce(pending);
  vi.stubGlobal("fetch", mock); show(); const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(screen.getByRole("button", { name: "Створюємо…" })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(2);
  resolve(json({ order }, 201));
  expect(await screen.findByRole("status")).toHaveTextContent("Заявку створено");
});
test("terminal or in-progress orders expose no cancellation button", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ orders: [
    { ...order, status: "COMPLETED" }, { ...order, id: "other-order", title: "Інша заявка", status: "IN_PROGRESS" },
  ] })));
  show();
  await screen.findByText("Завершена");
  expect(screen.getByText("У роботі")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
});
