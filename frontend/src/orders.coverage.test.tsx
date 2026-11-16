import { useEffect, useState, type ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";
import { CancelOrderDialog } from "./CancelOrderDialog";

// Each test gets independent synthetic identities and HTTP responses.
const fixture = () => ({ id: crypto.randomUUID(), type: "CUSTOM", title: "Синтетична coverage-заявка",
  description: "Синтетичний опис проблеми", city: "Тестоград", category: "PLUMBING",
  budget: null, status: "OPEN", createdAt: "2026-11-15T10:00:00.000Z" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-coverage-token"); setReady(true); }, [login]);
  return ready ? children : null;
}
function show() {
  render(<MemoryRouter initialEntries={["/orders"]}><AuthProvider recoverSession={false}><Session><App /></Session></AuthProvider></MemoryRouter>);
}
const labels = { title: "Назва проблеми", description: "Опис проблеми", city: "Місто", category: "Категорія", budget: /Бюджет, грн/ };
async function fill(except?: string) {
  const actions = userEvent.setup();
  await screen.findByRole("form", { name: "Нова заявка" });
  for (const [field, value] of [["title", "Нова синтетична проблема"], ["description", "Синтетичний опис"], ["city", "Тестоград"]] as const) {
    if (field !== except) await actions.type(screen.getByLabelText(labels[field]), value);
  }
  if (except !== "category") await actions.selectOptions(screen.getByLabelText(labels.category), "PLUMBING");
  return actions;
}
afterEach(() => vi.unstubAllGlobals());

test("creating a second order keeps the earlier card and adds the new OPEN card first", async () => {
  // Arrange
  const earlier = { ...fixture(), title: "Попередня синтетична заявка" };
  const created = { ...fixture(), title: "Нова синтетична проблема", createdAt: "2026-11-15T11:00:00.000Z" };
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [earlier] })).mockResolvedValueOnce(json({ order: created }, 201));
  vi.stubGlobal("fetch", mock); show();
  await screen.findByRole("article", { name: earlier.title });
  // Act
  const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  await screen.findByText("Заявку створено.");
  // Assert
  expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([created.title, earlier.title]);
  expect(within(screen.getByRole("article", { name: created.title })).getByText("Відкрита")).toBeInTheDocument();
  expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-coverage-token");
});

test.each(["title", "description", "city", "category"] as const)("required %s prevents an invalid POST", async (field) => {
  // Arrange
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] }));
  vi.stubGlobal("fetch", mock); show();
  // Act
  const actions = await fill(field);
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  // Assert: browser form validation stops the request; server Zod is tested by backend suites.
  expect(screen.getByLabelText(labels[field])).toBeInvalid();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Заявку створено.")).not.toBeInTheDocument();
});

test.each(["title", "description", "category", "budget"] as const)("server validation error for %s stays associated with the field and preserves the draft", async (field) => {
  // Arrange
  const message = `Сервер просить перевірити поле ${field}.`;
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({
    error: { message: "Перевірте поля заявки.", fields: { [field]: message } },
  }, 400));
  vi.stubGlobal("fetch", mock); show();
  // Act
  const actions = await fill();
  await actions.type(screen.getByLabelText(labels.budget), "250.50");
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  await screen.findByRole("alert");
  // Assert
  expect(screen.getByLabelText(labels[field])).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText(labels[field])).toHaveAttribute("aria-describedby", `order-${field}-error`);
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.getByLabelText(labels.title)).toHaveValue("Нова синтетична проблема");
  expect(screen.getByLabelText(labels.description)).toHaveValue("Синтетичний опис");
  expect(screen.getByLabelText(labels.budget)).toHaveValue("250.50");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});

test("POST 503 retains input and offers another submission without claiming success", async () => {
  // Arrange
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [] })).mockResolvedValueOnce(json({
    error: { message: "Створення тимчасово недоступне." },
  }, 503));
  vi.stubGlobal("fetch", mock); show();
  // Act
  const actions = await fill();
  await actions.click(screen.getByRole("button", { name: "Створити заявку" }));
  // Assert
  expect(await screen.findByRole("alert")).toHaveTextContent("Створення тимчасово недоступне");
  expect(screen.getByLabelText(labels.title)).toHaveValue("Нова синтетична проблема");
  expect(screen.getByRole("button", { name: "Створити заявку" })).toBeEnabled();
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});

test("confirmed DELETE 500 keeps the OPEN card and permits a deliberate retry", async () => {
  // Arrange
  const order = fixture();
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({
    error: { message: "Скасування тимчасово недоступне." },
  }, 500));
  vi.stubGlobal("fetch", mock); show();
  // Act
  await userEvent.click(await screen.findByRole("button", { name: "Скасувати заявку" }));
  await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" }));
  // Assert
  expect(await screen.findByRole("alert")).toHaveTextContent("Скасування тимчасово недоступне");
  expect(within(screen.getByRole("article", { name: order.title })).getByText("Відкрита")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Скасувати заявку" })).toBeEnabled();
  expect(screen.queryByText("Заявку скасовано.")).not.toBeInTheDocument();
  expect(mock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "DELETE"]);
});

test("a native closed-dialog event dismisses without confirming cancellation", () => {
  // Arrange
  const dismiss = vi.fn(), confirm = vi.fn();
  render(<CancelOrderDialog title={fixture().title} onDismiss={dismiss} onConfirm={confirm} />);
  const dialog = screen.getByRole("dialog");
  // Act: a browser close event fires after the native open state is cleared.
  dialog.removeAttribute("open");
  fireEvent(dialog, new Event("close"));
  // Assert
  expect(dismiss).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});
