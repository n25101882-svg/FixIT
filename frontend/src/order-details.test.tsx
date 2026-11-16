import { useEffect, useState, type ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";
import { safeOrderReturn } from "./order-return";

const id = "40000000-0000-4000-8000-000000000091";
const otherId = "40000000-0000-4000-8000-000000000092";
const clientPath = `/orders/${id}`, masterPath = `/master/orders/${id}`;
const master = { id: "synthetic-master-profile", name: "TestMaster1", city: "Тестоград", category: "PLUMBING", description: "Synthetic profile" };
const client = { id: "synthetic-client", name: "TestClient", email: "synthetic-client@fixit.test", role: "CLIENT" };
const times = ["2026-11-15T10:00:00.000Z", "2026-11-15T10:01:00.000Z", "2026-11-15T10:02:00.000Z", "2026-11-15T10:03:00.000Z"];
const order = { id, type: "CUSTOM", title: "Синтетичні деталі", description: "Синтетична проблема", city: "Тестоград", category: "PLUMBING", status: "COMPLETED", budget: "550.50", priceAtOrder: null,
  assignedMaster: master, createdAt: times[0], updatedAt: times[3], completedAt: times[3], timeline: ["OPEN", "ACCEPTED", "IN_PROGRESS", "COMPLETED"].map((status, i) => ({ status, at: times[i], source: "database" })) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number) => json({ error: { message: `Помилка ${status}` } }, status);
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth(); const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-details-token"); setReady(true); }, [login]); return ready ? children : null;
}
function Navigation() {
  const navigate = useNavigate(); const location = useLocation(); const { token } = useAuth();
  return <><span data-testid="location" hidden>{location.pathname + location.search}</span><span data-testid="session" hidden>{token ? "signed-in" : "signed-out"}</span>
    <button onClick={() => navigate(`/orders/${otherId}`)}>Інша заявка</button><button onClick={() => navigate("/catalog")}>Залишити деталі</button></>;
}
function show(path = clientPath, authenticated = true) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider recoverSession={false}>{authenticated ? <Session><App /><Navigation /></Session> : <><App /><Navigation /></>}</AuthProvider></MemoryRouter>);
}
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>((done) => { resolve = done; }); return { resolve, promise }; }
afterEach(() => vi.unstubAllGlobals());

test.each([clientPath, masterPath, `/orders/new/standard/${id}`])("allowlisted return path %s survives reauthentication", (path) => { expect(safeOrderReturn(path)).toBe(path); });
test("details return canonicalizes UUID case", () => { expect(safeOrderReturn(`/orders/${id.replace("000091", "00ABCD")}`)).toBe(`/orders/${id.replace("000091", "00abcd")}`); });
test.each([null, undefined, {}, 1, "https://evil.test", "//evil.test/orders/" + id, "/dashboard", "/orders", "/master/orders/available", "/master/orders/assigned", "/orders/invalid", clientPath + "?role=MASTER", masterPath + "#x", clientPath + "\n", clientPath + "/../admin", "/orders/%2F" + id])("unsafe details return %# is rejected", (path) => { expect(safeOrderReturn(path)).toBeNull(); });

test.each([clientPath, masterPath])("guest direct URL %s returns to the same page after login", async (path) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ accessToken: "synthetic-new-session", user: client })).mockResolvedValueOnce(json({ order })); vi.stubGlobal("fetch", mock); show(path, false);
  expect(new URL(screen.getByTestId("location").textContent!, "http://localhost").searchParams.get("returnTo")).toBe(path);
  await userEvent.type(screen.getByLabelText("Email"), client.email); await userEvent.type(screen.getByLabelText("Пароль", { exact: true }), "Synthetic login password"); await userEvent.click(screen.getByRole("button", { name: "Увійти" }));
  expect(await screen.findByRole("article", { name: order.title })).toBeInTheDocument(); expect(screen.getByTestId("location")).toHaveTextContent(path);
  expect(mock.mock.calls[1]?.[0]).toMatch(new RegExp(path + "$")); expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-new-session");
});
test.each([clientPath, masterPath])("loading and successful CUSTOM details on %s use authenticated GET", async (path) => {
  const pending = deferred(); const mock = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", mock); show(path);
  expect(screen.getByRole("status")).toHaveTextContent("Завантажуємо деталі"); expect(screen.getByRole("button", { name: "Оновити деталі" })).toBeDisabled();
  await act(async () => pending.resolve(json({ order })));
  const card = screen.getByRole("article", { name: order.title }); expect(card).toHaveTextContent("CUSTOM"); expect(card).toHaveTextContent(order.description); expect(card).toHaveTextContent("550,50 грн"); expect(card).toHaveTextContent(master.name);
  expect(mock.mock.calls[0]?.[0]).toMatch(new RegExp(path + "$")); expect(mock.mock.calls[0]?.[1].method).toBe("GET"); expect(mock.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer synthetic-details-token");
  expect(screen.queryByRole("button", { name: /Скасувати|Прийняти|Відхилити|Завершити роботу|Розпочати роботу/ })).not.toBeInTheDocument();
  if (path === clientPath) expect(screen.getByRole("link", { name: /Переглянути пропозиції/ })).toHaveAttribute("href", "/orders");
  else expect(screen.queryByRole("link", { name: /Переглянути пропозиції/ })).not.toBeInTheDocument();
});
test("complete timeline renders each real ISO time in server chronological order", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order }))); show();
  const list = await screen.findByRole("list", { name: "Історія статусів" }); const events = within(list).getAllByRole("listitem");
  expect(events.map((event) => event.querySelector("strong")?.textContent)).toEqual(["Відкрита", "Прийнята", "У роботі", "Завершена"]);
  expect(events.map((event) => event.querySelector("time")?.getAttribute("datetime"))).toEqual(times); expect(within(list).getAllByText("Запис БД")).toHaveLength(4);
  expect(within(screen.getByRole("article")).getByText("Завершено").parentElement?.querySelector("time")).toHaveAttribute("datetime", times[3]);
});
test.each(["425.50", null])("STANDARD uses historical price %s and PENDING timeline without CUSTOM proposals", async (priceAtOrder) => {
  const standard = { ...order, type: "STANDARD", status: "PENDING", priceAtOrder, budget: null, completedAt: null, timeline: [{ status: "PENDING", at: times[0], source: "database" }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order: standard }))); show(); const card = await screen.findByRole("article");
  expect(card).toHaveTextContent("STANDARD"); expect(card).toHaveTextContent("Очікує відповіді"); expect(card).toHaveTextContent(priceAtOrder === null ? "Ціна за домовленістю" : "425,50 грн");
  expect(card).not.toHaveTextContent("Бюджет"); expect(screen.queryByRole("link", { name: /Переглянути пропозиції/ })).not.toBeInTheDocument(); expect(card).not.toHaveTextContent("Завершено");
});
test.each(["CANCELLED", "DECLINED"])("terminal %s remains readable with no mutation actions", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order: { ...order, status, completedAt: null, timeline: [{ status, at: times[1] }] } }))); show(masterPath);
  const card = await screen.findByRole("article"); expect(card).toHaveTextContent(status === "CANCELLED" ? "Скасована" : "Відхилена");
  expect(within(card).queryByRole("button")).not.toBeInTheDocument(); expect(card).not.toHaveTextContent("Завершено");
});
test("unassigned CUSTOM/null budget and absent update date are explicit", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order: { ...order, status: "OPEN", budget: null, assignedMaster: null, updatedAt: undefined, completedAt: null, timeline: [] } }))); show();
  const card = await screen.findByRole("article"); expect(card).toHaveTextContent("Ще не призначено"); expect(card).toHaveTextContent("Бюджет не вказано"); expect(card).not.toHaveTextContent("Оновлено"); expect(screen.getByText("Історію статусів не збережено.")).toBeInTheDocument();
});
test("legacy/incomplete timeline labels migration and unknown time without inventing authors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order: { ...order, completedAt: null, timeline: [{ status: "ACCEPTED", at: times[0], source: "legacy_migration" }, { status: "COMPLETED", at: null }] } }))); show();
  expect(await screen.findByText("Історичний стан, зафіксований під час міграції")).toBeInTheDocument(); expect(screen.getByText("Час події не збережено")).toBeInTheDocument(); expect(screen.getByText("Час завершення не збережено")).toBeInTheDocument();
  expect(screen.getByText(/Події без відомого часу/)).toBeInTheDocument(); expect(screen.queryByText(/actorUserId|Адміністратор|Автор:/)).not.toBeInTheDocument();
});
test.each([403, 404, 500])("HTTP %s has safe error, no private card and working retry", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(error(status)).mockResolvedValueOnce(json({ order })); vi.stubGlobal("fetch", mock); show();
  const alert = await screen.findByRole("alert"); expect(alert).toHaveTextContent(status === 403 ? "Немає дозволу" : status === 404 ? "не знайдено" : "Помилка 500"); expect(screen.queryByRole("article")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" })); expect(await screen.findByRole("article", { name: order.title })).toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(2);
});
test("network failure keeps navigation and retry, never a fake detail record", async () => {
  const mock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json({ order })); vi.stubGlobal("fetch", mock); show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу"); expect(screen.getByRole("link", { name: "До моїх замовлень" })).toHaveAttribute("href", "/orders");
  await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" })); expect(await screen.findByRole("article")).toBeInTheDocument();
});
test("unreadable server response offers retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 500 })).mockResolvedValueOnce(json({ order }))); show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Не вдалося прочитати"); await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" })); expect(await screen.findByRole("article")).toBeInTheDocument();
});
test("empty detail response is treated as not found", async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ order: null }))); show(); expect(await screen.findByRole("alert")).toHaveTextContent("не знайдено"); });
test.each([clientPath, masterPath])("HTTP 401 logs out and retains only safe direct URL %s", async (path) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(error(401))); show(path); expect(await screen.findByRole("form", { name: "Вхід" })).toBeInTheDocument();
  expect(screen.getByTestId("session")).toHaveTextContent("signed-out"); expect(screen.queryByRole("article")).not.toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("Сесія завершилася");
  expect(new URL(screen.getByTestId("location").textContent!, "http://localhost").searchParams.get("returnTo")).toBe(path);
});
test("refresh gets updated lifecycle and completion date without F5", async () => {
  const initial = { ...order, status: "ACCEPTED", completedAt: null, timeline: order.timeline.slice(0, 2) };
  const mock = vi.fn().mockResolvedValueOnce(json({ order: initial })).mockResolvedValueOnce(json({ order })); vi.stubGlobal("fetch", mock); show(); await screen.findByRole("article");
  expect(screen.queryByText("Завершено")).not.toBeInTheDocument(); await userEvent.click(screen.getByRole("button", { name: "Оновити деталі" }));
  const card = await screen.findByRole("article"); expect(card).toHaveTextContent("Завершена"); expect(card).toHaveTextContent("Завершено"); expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(4);
});
test.each([403, 404, 500])("refresh HTTP %s removes all previously visible private details", async (status) => {
  const pending = deferred(); const mock = vi.fn().mockResolvedValueOnce(json({ order })).mockReturnValueOnce(pending.promise); vi.stubGlobal("fetch", mock); show(); await screen.findByRole("article");
  await userEvent.click(screen.getByRole("button", { name: "Оновити деталі" })); expect(screen.queryByText(order.description)).not.toBeInTheDocument();
  await act(async () => pending.resolve(error(status))); expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText(order.title)).not.toBeInTheDocument(); expect(screen.queryByRole("list", { name: "Історія статусів" })).not.toBeInTheDocument();
});
test("route change immediately clears old details and aborts old pending read", async () => {
  const pending = deferred(); const mock = vi.fn().mockResolvedValueOnce(json({ order })).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ order: { ...order, id: otherId, title: "Інше дозволене замовлення" } })); vi.stubGlobal("fetch", mock); show(); await screen.findByRole("article");
  await userEvent.click(screen.getByRole("button", { name: "Оновити деталі" })); await userEvent.click(screen.getByRole("button", { name: "Інша заявка" }));
  expect(mock.mock.calls[1]?.[1].signal.aborted).toBe(true); expect(await screen.findByRole("article", { name: "Інше дозволене замовлення" })).toBeInTheDocument();
  await act(async () => pending.resolve(json({ order }))); expect(screen.queryByText(order.title)).not.toBeInTheDocument();
});
test.each([401, 403, 500])("late HTTP %s from an old route cannot overwrite current details or logout", async (status) => {
  const pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ order: { ...order, id: otherId, title: "Актуальні деталі" } })); vi.stubGlobal("fetch", mock); show();
  await userEvent.click(screen.getByRole("button", { name: "Інша заявка" })); await screen.findByRole("article", { name: "Актуальні деталі" });
  await act(async () => pending.resolve(error(status))); expect(screen.getByRole("article", { name: "Актуальні деталі" })).toBeInTheDocument(); expect(screen.getByTestId("session")).toHaveTextContent("signed-in"); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test("unmount aborts GET and late rejection never affects the next page", async () => {
  const pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ services: [], total: 0, page: 1, limit: 12, totalPages: 1 })); vi.stubGlobal("fetch", mock); show();
  await userEvent.click(screen.getByRole("button", { name: "Залишити деталі" })); expect(mock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  await act(async () => pending.resolve(error(401))); expect(screen.getByTestId("location")).toHaveTextContent("/catalog"); expect(screen.getByTestId("session")).toHaveTextContent("signed-in");
});
test("CLIENT list details link and back navigation preserve existing creation/cancellation", async () => {
  const open = { ...order, status: "OPEN", completedAt: null, assignedMaster: null };
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [open] })).mockResolvedValueOnce(json({ order: open })).mockResolvedValueOnce(json({ orders: [open] })); vi.stubGlobal("fetch", mock); show("/orders");
  const card = await screen.findByRole("article", { name: order.title }); expect(within(card).getByRole("button", { name: "Скасувати заявку" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("link", { name: "Переглянути деталі" })); await screen.findByRole("heading", { name: "Деталі замовлення" }); await screen.findByRole("article");
  await userEvent.click(screen.getByRole("link", { name: "До моїх замовлень" })); expect(await screen.findByRole("form", { name: "Нова заявка" })).toBeInTheDocument(); expect(await screen.findByRole("article", { name: order.title })).toBeInTheDocument();
  expect(mock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
});
test("MASTER assigned card links to its own detail API and back to assignments", async () => {
  const me = { ...client, role: "MASTER", name: "TestMaster1" }; const mock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/users/me")) return Promise.resolve(json({ user: me }));
    if (url.endsWith("/master/orders/assigned")) return Promise.resolve(json({ orders: [order] }));
    return Promise.resolve(json({ order }));
  }); vi.stubGlobal("fetch", mock); show("/dashboard");
  const card = await screen.findByRole("article", { name: order.title }); expect(card).toHaveTextContent(`Створено: ${new Date(times[0]!).toLocaleString("uk-UA")}`); await userEvent.click(within(card).getByRole("link", { name: "Переглянути деталі" }));
  await screen.findByRole("heading", { name: "Історія статусів" }); expect(screen.getByTestId("location")).toHaveTextContent(masterPath);
  await userEvent.click(screen.getByRole("link", { name: "До моїх замовлень" })); expect(await screen.findByRole("heading", { name: "Призначені мені заявки" })).toBeInTheDocument();
  expect(mock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
});
