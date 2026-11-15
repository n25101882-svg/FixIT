import { useEffect, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";

const order = { id: "review-order", type: "CUSTOM", title: "Синтетична review-заявка", description: "Синтетичний опис",
  city: "Тестоград", category: "PLUMBING", budget: null, status: "OPEN", createdAt: "2026-11-15T10:00:00.000Z" };
const conflict = "Поточний стан заявки не дозволяє скасування. Оновіть список.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const snapshot = (status = "OPEN") => json({ orders: [{ ...order, status }] });
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-review-token"); setReady(true); }, [login]);
  return ready ? children : null;
}
function show() {
  render(<MemoryRouter initialEntries={["/orders"]}><AuthProvider><Session><App /></Session></AuthProvider></MemoryRouter>);
}
async function confirm() {
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" }));
}
async function fill() {
  const actions = userEvent.setup();
  await actions.type(screen.getByLabelText("Назва проблеми"), order.title);
  await actions.type(screen.getByLabelText("Опис проблеми"), order.description);
  await actions.type(screen.getByLabelText("Місто"), order.city);
  await actions.selectOptions(screen.getByLabelText("Категорія"), order.category);
  return actions;
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}
afterEach(() => vi.unstubAllGlobals());

test.each(["Ні, залишити", "Закрити діалог"])("REVIEW-01: %s dismisses without any HTTP request and restores focus", async (label) => {
  const mock = vi.fn().mockResolvedValue(snapshot());
  vi.stubGlobal("fetch", mock); show();
  const trigger = await screen.findByRole("button", { name: "Скасувати заявку" });
  await userEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Скасувати заявку?" });
  expect(within(dialog).getByText(/Синтетична review-заявка/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ні, залишити" })).toHaveFocus();
  expect(mock).toHaveBeenCalledTimes(1);
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(mock).toHaveBeenCalledTimes(1);
});
test("REVIEW-01: native cancel event closes without DELETE", async () => {
  const mock = vi.fn().mockResolvedValue(snapshot());
  vi.stubGlobal("fetch", mock); show();
  const trigger = await screen.findByRole("button", { name: "Скасувати заявку" });
  await userEvent.click(trigger);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(mock).toHaveBeenCalledTimes(1);
});
test("REVIEW-01: a queued close event from StrictMode cleanup cannot dismiss a reopened dialog", async () => {
  const mock = vi.fn().mockResolvedValue(snapshot());
  vi.stubGlobal("fetch", mock); show();
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  const dialog = screen.getByRole("dialog");
  fireEvent(dialog, new Event("close"));
  expect(dialog).toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(1);
});
test("REVIEW-01: keyboard confirmation sends exactly one DELETE", async () => {
  const mock = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ order: { ...order, status: "CANCELLED" } }));
  vi.stubGlobal("fetch", mock); show();
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  expect(mock).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Tab}{Enter}");
  expect(await screen.findByText("Скасована")).toBeInTheDocument();
  expect(mock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "DELETE"]);
});
test("REVIEW-01: Tab and Shift+Tab wrap inside the dialog", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(snapshot())); show();
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  await userEvent.keyboard("{Tab}");
  expect(screen.getByRole("button", { name: "Так, скасувати" })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  expect(screen.getByRole("button", { name: "Закрити діалог" })).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(screen.getByRole("button", { name: "Так, скасувати" })).toHaveFocus();
});

test.each(["CANCELLED", "IN_PROGRESS"])("REVIEW-02: 409 automatically reads %s and retains conflict feedback", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ error: { message: conflict } }, 409)).mockResolvedValueOnce(snapshot(status));
  vi.stubGlobal("fetch", mock); show(); await confirm();
  await screen.findByText(status === "CANCELLED" ? "Скасована" : "У роботі");
  expect(mock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "DELETE", "GET"]);
  expect(mock.mock.calls[2]?.[1].headers.Authorization).toBe("Bearer synthetic-review-token");
  expect(screen.getByRole("alert")).toHaveTextContent(conflict);
  expect(screen.queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
});
test("REVIEW-02: pending resynchronization keeps the conflict and disables stale cancellation", async () => {
  const pending = deferred();
  const mock = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ error: { message: conflict } }, 409)).mockReturnValueOnce(pending.promise);
  vi.stubGlobal("fetch", mock); show(); await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(conflict);
  expect(screen.getByRole("button", { name: "Скасовуємо…" })).toBeDisabled();
  expect(screen.getByText("Відкрита")).toBeInTheDocument();
  await act(async () => { pending.resolve(snapshot("CANCELLED")); });
  expect(screen.getByText("Скасована")).toBeInTheDocument();
});
test.each(["500", "network"])("REVIEW-02: failed GET (%s) preserves conflict, disables stale actions and supports retry", async (kind) => {
  const mock = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ error: { message: conflict } }, 409))
    .mockImplementationOnce(() => kind === "network" ? Promise.reject(new TypeError("offline")) : Promise.resolve(json({ error: { message: "Історія тимчасово недоступна." } }, 500)))
    .mockResolvedValueOnce(snapshot("CANCELLED"));
  vi.stubGlobal("fetch", mock); show(); await confirm();
  const retry = await screen.findByRole("button", { name: "Спробувати ще раз" });
  expect(screen.getAllByRole("alert").map((item) => item.textContent).join(" ")).toContain(conflict);
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Скасувати заявку" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Створити заявку" })).toBeEnabled();
  await userEvent.click(retry);
  await screen.findByText("Скасована");
  expect(screen.getByRole("alert")).toHaveTextContent(conflict);
  expect(mock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "DELETE", "GET", "GET"]);
});
test("REVIEW-02: revalidation 401 logs out", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ error: { message: conflict } }, 409))
    .mockResolvedValueOnce(json({ error: { message: "Unauthorized" } }, 401)));
  show(); await confirm();
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Нова заявка" })).not.toBeInTheDocument();
});
test("REVIEW-02: revalidation 403 blocks CLIENT actions and retains the conflict", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(json({ error: { message: conflict } }, 409))
    .mockResolvedValueOnce(json({ error: { message: "Заявки доступні лише клієнтам." } }, 403)));
  show(); await confirm();
  await screen.findByText("Заявки доступні лише клієнтам.");
  expect(screen.getAllByRole("alert").map((item) => item.textContent).join(" ")).toContain(conflict);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
});

test.each(["500", "503", "network"])("FIX-18: initial history %s does not prevent CLIENT creation", async (kind) => {
  const mock = vi.fn().mockImplementationOnce(() => kind === "network" ? Promise.reject(new TypeError("offline"))
    : Promise.resolve(json({ error: { message: "Історія тимчасово недоступна." } }, Number(kind))))
    .mockResolvedValueOnce(json({ order }, 201));
  vi.stubGlobal("fetch", mock); show();
  await screen.findByRole("alert");
  const form = screen.getByRole("form", { name: "Нова заявка" });
  expect(within(form).getByRole("button", { name: "Створити заявку" })).toBeEnabled();
  const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Заявку створено");
  expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument();
  expect(mock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "POST"]);
});
test("FIX-18: loading history keeps the form and entered fields mounted", async () => {
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise)); show();
  const form = await screen.findByRole("form", { name: "Нова заявка" });
  await userEvent.type(screen.getByLabelText("Назва проблеми"), "Незавершена чернетка");
  expect(screen.getByRole("status")).toHaveTextContent("Завантажуємо заявки");
  await act(async () => { pending.resolve(json({ orders: [] })); });
  expect(screen.getByRole("form", { name: "Нова заявка" })).toBe(form);
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue("Незавершена чернетка");
});
test("FIX-18: retry loading does not discard form input", async () => {
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ error: { message: "Temporary failure" } }, 500)).mockReturnValueOnce(pending.promise));
  show(); await screen.findByRole("alert");
  await userEvent.type(screen.getByLabelText("Назва проблеми"), "Моя чернетка");
  await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue("Моя чернетка");
  expect(screen.getByRole("button", { name: "Створити заявку" })).toBeEnabled();
  await act(async () => { pending.resolve(json({ orders: [] })); });
  expect(screen.getByLabelText("Назва проблеми")).toHaveValue("Моя чернетка");
});
test("FIX-18: a slow initial GET cannot erase a committed new order", async () => {
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ order }, 201)));
  show(); await screen.findByRole("form");
  const actions = await fill(); await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  await screen.findByRole("article", { name: order.title });
  await act(async () => { pending.resolve(json({ orders: [] })); });
  expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument();
  expect(screen.queryByText(/У вас поки немає заявок/)).not.toBeInTheDocument();
});
test("FIX-18: a stale GET cannot unblock the form after POST 403", async () => {
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ error: { message: "Заявки доступні лише клієнтам." } }, 403)));
  show(); await screen.findByRole("form");
  const actions = await fill(); await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  await screen.findByRole("alert");
  await act(async () => { pending.resolve(json({ orders: [] })); });
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
test("FIX-18: POST 401 still logs out", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({ error: { message: "Unauthorized" } }, 401)));
  show(); await screen.findByText(/У вас поки немає заявок/);
  const actions = await fill(); await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
