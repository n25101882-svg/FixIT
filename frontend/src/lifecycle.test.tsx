import { useEffect, useState, type ReactNode } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";

const order = { id: "synthetic-lifecycle", type: "CUSTOM", title: "Синтетична робота", description: "Синтетичний опис",
  city: "Тестоград", category: "OTHER", budget: null, status: "ACCEPTED", completedAt: null, createdAt: "2026-11-15T09:00:00.000Z" };
const progress = { ...order, status: "IN_PROGRESS" };
const completed = { ...order, status: "COMPLETED", completedAt: "2026-11-15T15:07:32.123Z" };
const user = { id: "master-user", email: "synthetic-master@fixit.test", name: "Синтетичний майстер", role: "MASTER" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number, message = `Помилка ${status}`) => json({ error: { message } }, status);
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth(); const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-lifecycle-token"); setReady(true); }, [login]);
  return ready ? children : null;
}
function show(path = "/dashboard") {
  render(<MemoryRouter initialEntries={[path]}><AuthProvider><Session><App /></Session></AuthProvider></MemoryRouter>);
}
function setup(orders: unknown[] = [order]) {
  const mock = vi.fn().mockResolvedValueOnce(json({ user })).mockResolvedValueOnce(json({ orders }));
  vi.stubGlobal("fetch", mock); return mock;
}
afterEach(() => vi.unstubAllGlobals());

test("MASTER starts and completes without reload using PATCH status-only body and JWT", async () => {
  const mock = setup(); mock.mockResolvedValueOnce(json({ order: progress })).mockResolvedValueOnce(json({ order: completed })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByText("Роботу розпочато.")).toBeInTheDocument(); expect(screen.getByText("У роботі")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Завершити роботу" }));
  expect(await screen.findByText("Роботу завершено.")).toBeInTheDocument(); expect(screen.getByText("Завершена")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Розпочати роботу|Завершити роботу/ })).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(4);
  for (const [index, status] of [[2, "IN_PROGRESS"], [3, "COMPLETED"]] as const) {
    expect(mock.mock.calls[index]?.[0]).toMatch(/\/master\/orders\/synthetic-lifecycle\/status$/);
    expect(mock.mock.calls[index]?.[1].method).toBe("PATCH");
    expect(mock.mock.calls[index]?.[1].headers.Authorization).toBe("Bearer synthetic-lifecycle-token");
    expect(JSON.parse(mock.mock.calls[index]?.[1].body)).toEqual({ status });
  }
  const card = screen.getByRole("article", { name: order.title });
  expect(card.querySelector("time")).toHaveAttribute("datetime", completed.completedAt);
});
test.each(["COMPLETED", "CANCELLED", "DECLINED", "OPEN"])("CUSTOM %s has no execution action", async (status) => {
  setup([{ ...order, status }]); show(); await screen.findByRole("article", { name: order.title });
  expect(screen.queryByRole("button", { name: /Розпочати роботу|Завершити роботу/ })).not.toBeInTheDocument();
});
test.each(["PENDING", "ACCEPTED"])("STANDARD %s exposes only the current lifecycle actions", async (status) => {
  setup([{ ...order, type: "STANDARD", status }]); show(); await screen.findByRole("article", { name: order.title });
  const card = screen.getByRole("article", { name: order.title });
  const labels = status === "PENDING" ? ["Прийняти", "Відхилити"] : ["Розпочати роботу"];
  for (const name of labels) expect(within(card).getByRole("button", { name })).toBeEnabled();
  expect(within(card).getAllByRole("button")).toHaveLength(labels.length);
});
test("unknown legacy completion date is not replaced by createdAt/current time", async () => {
  setup([{ ...completed, completedAt: null }]); show(); await screen.findByText("Завершена");
  expect(screen.queryByText(/Завершено:/)).not.toBeInTheDocument(); expect(screen.getByRole("article").querySelector("time")).toBeNull();
});
test("repeated clicks and other lifecycle actions are blocked during PATCH", async () => {
  const mock = setup([order, { ...order, id: "second", title: "Друга робота" }]);
  mock.mockImplementationOnce(() => new Promise(() => {})); show();
  const buttons = await screen.findAllByRole("button", { name: "Розпочати роботу" }); await userEvent.dblClick(buttons[0]!);
  expect(screen.getByRole("button", { name: "Зберігаємо…" })).toBeDisabled(); expect(buttons[1]).toBeDisabled();
  expect(screen.getByRole("button", { name: "Оновити призначення" })).toBeDisabled();
  expect(mock.mock.calls.filter((call) => call[1].method === "PATCH")).toHaveLength(1);
});
test.each([progress, completed])("409 reloads current $status while retaining conflict message", async (current) => {
  const mock = setup(); mock.mockResolvedValueOnce(error(409, "Конфлікт статусу")).mockResolvedValueOnce(json({ orders: [current] })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByText(current.status === "IN_PROGRESS" ? "У роботі" : "Завершена")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Конфлікт статусу");
  expect(mock.mock.calls[3]?.[0]).toMatch(/\/master\/orders\/assigned$/); expect(mock.mock.calls[3]?.[1].method).toBe("GET");
  expect(screen.queryByRole("button", { name: "Розпочати роботу" })).not.toBeInTheDocument();
});
test("failed conflict GET preserves card and both errors, disables stale action until retry", async () => {
  const mock = setup(); mock.mockResolvedValueOnce(error(409, "Конфлікт статусу")).mockResolvedValueOnce(error(503, "Синхронізація недоступна"))
    .mockResolvedValueOnce(json({ orders: [progress] })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByText("Синхронізація недоступна")).toBeInTheDocument(); expect(screen.getByText("Конфлікт статусу")).toBeInTheDocument();
  expect(screen.getByRole("article", { name: order.title })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" }));
  expect(await screen.findByRole("button", { name: "Завершити роботу" })).toBeEnabled(); expect(screen.getByText("Конфлікт статусу")).toBeInTheDocument();
});
test("lost PATCH response revalidates committed state rather than automatically repeating PATCH", async () => {
  const mock = setup(); mock.mockRejectedValueOnce(new TypeError("network lost after commit")).mockResolvedValueOnce(json({ orders: [progress] })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByRole("button", { name: "Завершити роботу" })).toBeEnabled(); expect(screen.getByRole("alert")).toHaveTextContent("Перевірте мережу");
  expect(mock.mock.calls.filter((call) => call[1].method === "PATCH")).toHaveLength(1);
});
test("network failure and failed GET require synchronization before retrying unchanged status", async () => {
  const mock = setup(); mock.mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order: progress })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  await screen.findByText("Оновіть призначення перед повторною дією."); expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeDisabled();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Розпочати роботу" })); expect(await screen.findByText("У роботі")).toBeInTheDocument();
  expect(mock.mock.calls.filter((call) => call[1].method === "PATCH")).toHaveLength(2);
});
test.each([400, 404, 500])("PATCH %s preserves error and syncs before offering another action", async (status) => {
  const mock = setup(); mock.mockResolvedValueOnce(error(status)).mockResolvedValueOnce(json({ orders: [order] })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`);
  await waitFor(() => expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeEnabled());
  expect(screen.getByText("Прийнята")).toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(4);
});
test("403 permanently blocks another mutation for that card even after a successful GET", async () => {
  const mock = setup(); mock.mockResolvedValueOnce(error(403)).mockResolvedValueOnce(json({ orders: [order] })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  await screen.findByText("Немає дозволу змінювати цю заявку."); expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(3);
  await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" })); await waitFor(() => expect(mock).toHaveBeenCalledTimes(4));
  await userEvent.click(screen.getByRole("button", { name: "Розпочати роботу" }));
  expect(mock.mock.calls.filter((call) => call[1].method === "PATCH")).toHaveLength(1);
});
test.each(["patch", "refresh"])("401 during %s uses existing logout", async (phase) => {
  const mock = setup();
  if (phase === "refresh") mock.mockResolvedValueOnce(error(409)); mock.mockResolvedValueOnce(error(401)); show();
  await userEvent.click(await screen.findByRole("button", { name: "Розпочати роботу" }));
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Призначені заявки" })).not.toBeInTheDocument();
});
test("failed history refresh retains card and blocks mutations until a successful refresh", async () => {
  const mock = setup(); mock.mockResolvedValueOnce(error(503)).mockResolvedValueOnce(json({ orders: [order] })); show();
  await screen.findByRole("button", { name: "Розпочати роботу" }); await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 503"); expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" })); await waitFor(() => expect(screen.getByRole("button", { name: "Розпочати роботу" })).toBeEnabled());
});
test("CLIENT refresh sees progress/completion history and never offers cancellation after starting", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ orders: [progress] })).mockResolvedValueOnce(json({ orders: [completed] }));
  vi.stubGlobal("fetch", mock); show("/orders"); const card = await screen.findByRole("article", { name: order.title });
  expect(within(card).getByRole("button", { name: "Скасувати заявку" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Оновити" })); expect(await within(card).findByText("У роботі")).toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Оновити" })); expect(await within(card).findByText("Завершена")).toBeInTheDocument();
  expect(card.querySelector(`time[datetime="${completed.completedAt}"]`)).toBeInTheDocument();
  expect(within(card).queryByRole("button", { name: "Скасувати заявку" })).not.toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(3);
});
