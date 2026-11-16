import { useEffect, useState, type ReactNode } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";

const order = { id: "offer-order", type: "CUSTOM", title: "Синтетична проблема US-06", description: "Синтетичний опис",
  city: "Тестоград", category: "PLUMBING", budget: null, status: "OPEN", masterProfileId: null, assignedMaster: null, createdAt: "2026-11-15T10:00:00.000Z" };
const master = { id: "public-profile-a", name: "Синтетичний майстер", city: "Тестоград", category: "PLUMBING", description: "Синтетичний профіль" };
const response = { id: "response-a", message: "Допоможу з проблемою", proposedPrice: null, master };
const accepted = { ...order, status: "ACCEPTED", masterProfileId: master.id, assignedMaster: master };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const failure = (status: number, message = `Помилка ${status}`) => json({ error: { message } }, status);
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth(); const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-offers-token"); setReady(true); }, [login]);
  return ready ? children : null;
}
function show(path = "/orders", authenticated = true) {
  render(<MemoryRouter initialEntries={[path]}><AuthProvider recoverSession={false}>{authenticated ? <Session><App /></Session> : <App />}</AuthProvider></MemoryRouter>);
}
async function openOffers() {
  await userEvent.click(await screen.findByRole("button", { name: "Переглянути пропозиції" }));
}
afterEach(() => vi.unstubAllGlobals());

test("offers load only when opened, using verified session header and no identity query", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response] }));
  vi.stubGlobal("fetch", mock); show();
  await screen.findByRole("article", { name: order.title }); expect(mock).toHaveBeenCalledTimes(1);
  await openOffers(); expect(await screen.findByText(response.message)).toBeInTheDocument();
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/orders\/offer-order\/responses$/);
  expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-offers-token");
  expect(screen.getByText(master.name)).toBeInTheDocument();
});
test("offers have Loading, Empty and collapsible states", async () => {
  let resolve!: (r: Response) => void;
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", mock); show(); await openOffers();
  expect(screen.getByText("Завантажуємо пропозиції…")).toBeInTheDocument();
  resolve(json({ order, responses: [] })); expect(await screen.findByText("Пропозицій поки немає.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Переглянути пропозиції" }));
  expect(screen.queryByText("Пропозицій поки немає.")).not.toBeInTheDocument();
  await openOffers(); expect(mock).toHaveBeenCalledTimes(2);
});
test("CLIENT selects one response and parent immediately displays ACCEPTED and public executor", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response] })).mockResolvedValueOnce(json({ order: accepted }));
  vi.stubGlobal("fetch", mock); show(); await openOffers();
  await userEvent.click(await screen.findByRole("button", { name: "Обрати майстра" }));
  expect(await screen.findByText("Виконавця обрано.")).toBeInTheDocument();
  expect(screen.getByText(`Виконавець: ${master.name}`)).toBeInTheDocument(); expect(screen.getByText("Прийнята")).toBeInTheDocument();
  expect(screen.getByText("Обраний виконавець")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Обрати майстра" })).not.toBeInTheDocument();
  expect(mock.mock.calls[2]?.[0]).toMatch(/\/select-response$/);
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({ responseId: response.id });
  expect(mock.mock.calls[2]?.[1].method).toBe("POST");
});
test("all choice buttons disable during an in-flight selection", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response, { ...response, id: "response-b", master: { ...master, id: "profile-b", name: "Другий майстер" } }] })).mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal("fetch", mock); show(); await openOffers();
  const buttons = await screen.findAllByRole("button", { name: "Обрати майстра" }); await userEvent.click(buttons[0]!);
  for (const button of screen.getAllByRole("button", { name: "Обираємо…" })) expect(button).toBeDisabled();
});
test("409 automatically reloads offers/current status and preserves conflict message", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response] }))
    .mockResolvedValueOnce(failure(409, "Виконавця вже обрано"))
    .mockResolvedValueOnce(json({ order: accepted, responses: [response] }));
  vi.stubGlobal("fetch", mock); show(); await openOffers(); await userEvent.click(await screen.findByRole("button", { name: "Обрати майстра" }));
  expect(await screen.findByText("Прийнята")).toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Виконавця вже обрано");
  expect(mock.mock.calls[3]?.[0]).toMatch(/\/responses$/); expect(mock.mock.calls[3]?.[1].method).toBe("GET");
});
test("failed revalidation after 409 keeps conflict/error, disables stale choices, and supports retry", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response] }))
    .mockResolvedValueOnce(failure(409, "Конфлікт вибору" )).mockResolvedValueOnce(failure(503, "Оновлення недоступне"))
    .mockResolvedValueOnce(json({ order: accepted, responses: [response] }));
  vi.stubGlobal("fetch", mock); show(); await openOffers(); await userEvent.click(await screen.findByRole("button", { name: "Обрати майстра" }));
  expect(await screen.findByText(/Оновлення недоступне/)).toBeInTheDocument(); expect(screen.getByText("Конфлікт вибору")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Обрати майстра" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Оновити пропозиції" })); expect(await screen.findByText("Прийнята")).toBeInTheDocument();
  expect(screen.getByText("Конфлікт вибору")).toBeInTheDocument();
});
test.each([400, 403, 404, 500])("selection HTTP %s preserves order without a false success", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(json({ order, responses: [response] })).mockResolvedValueOnce(failure(status));
  vi.stubGlobal("fetch", mock); show(); await openOffers(); await userEvent.click(await screen.findByRole("button", { name: "Обрати майстра" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`);
  expect(screen.getByText("Відкрита")).toBeInTheDocument(); expect(screen.queryByText("Виконавця обрано.")).not.toBeInTheDocument();
});
test.each(["read", "select"])("401 during %s logs out via existing session mechanism", async (operation) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] }));
  if (operation === "select") mock.mockResolvedValueOnce(json({ order, responses: [response] }));
  mock.mockResolvedValueOnce(failure(401)); vi.stubGlobal("fetch", mock); show(); await openOffers();
  if (operation === "select") await userEvent.click(await screen.findByRole("button", { name: "Обрати майстра" }));
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
test("offers GET network error retains client creation form and retries", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(json({ order, responses: [{ ...response, proposedPrice: "12.34" }] }));
  vi.stubGlobal("fetch", mock); show(); await openOffers();
  expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу"); expect(screen.getByRole("form", { name: "Нова заявка" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Оновити пропозиції" }));
  expect(await screen.findByText("Орієнтовна ціна: 12.34 грн")).toBeInTheDocument();
});
test.each(["ACCEPTED", "CANCELLED", "COMPLETED"])("historical %s order shows offers but no choice button", async (status) => {
  const closed = { ...accepted, status };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [closed] })).mockResolvedValueOnce(json({ order: closed, responses: [response] })));
  show(); await openOffers(); await screen.findByText(response.message);
  expect(screen.queryByRole("button", { name: "Обрати майстра" })).not.toBeInTheDocument();
});
test("STANDARD order has no CUSTOM offer controls", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ orders: [{ ...order, type: "STANDARD", status: "PENDING" }] })));
  show(); await screen.findByRole("article"); expect(screen.queryByRole("button", { name: "Переглянути пропозиції" })).not.toBeInTheDocument();
});
test("a delayed offers GET cannot restore OPEN after a committed cancellation", async () => {
  let resolve!: (r: Response) => void;
  const initial = { ...order, updatedAt: "2026-11-15T10:00:00.000Z", statusHistory: [{ status: "OPEN" }] };
  const cancelled = { ...initial, status: "CANCELLED", updatedAt: "2026-11-15T10:01:00.000Z", statusHistory: [{ status: "OPEN" }, { status: "CANCELLED" }] };
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [initial] }))
    .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValueOnce(json({ order: cancelled }));
  vi.stubGlobal("fetch", mock); show(); await openOffers();
  await userEvent.click(screen.getByRole("button", { name: "Скасувати заявку" }));
  await userEvent.click(screen.getByRole("button", { name: "Так, скасувати" })); await screen.findByText("Скасована");
  resolve(json({ order: initial, responses: [response] })); await screen.findByText(response.message);
  expect(screen.getByText("Скасована")).toBeInTheDocument(); expect(screen.queryByText("Відкрита")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Обрати майстра" })).not.toBeInTheDocument();
});

test("MASTER route is protected for guests", () => {
  show("/master/orders", false); expect(screen.getByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
test("MASTER feed supports Loading and Empty", async () => {
  let resolve!: (r: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  show("/master/orders"); expect(await screen.findByText("Завантажуємо доступні заявки…")).toBeInTheDocument();
  resolve(json({ orders: [] })); expect(await screen.findByText(/Відкритих заявок за вашим профілем поки немає/)).toBeInTheDocument();
});
test("MASTER submits text-only offer with JWT and keeps own response visible without reload", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [{ ...order, myResponse: null }] })).mockResolvedValueOnce(json({ response: { id: response.id, message: response.message } }, 201));
  vi.stubGlobal("fetch", mock); show("/master/orders");
  await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), response.message);
  await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByText("Пропозицію надіслано клієнту.")).toBeInTheDocument();
  expect(screen.getByText(response.message)).toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(JSON.parse(mock.mock.calls[1]?.[1].body)).toEqual({ message: response.message });
  expect(mock.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer synthetic-offers-token");
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/master\/orders\/offer-order\/responses$/);
});
test("own existing proposal suppresses a duplicate form", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ orders: [{ ...order, myResponse: response }] })));
  show("/master/orders"); expect(await screen.findByText("Пропозицію надіслано")).toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
test.each([403, 500])("MASTER feed GET %s shows safe error and no actionable offers", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failure(status))); show("/master/orders");
  expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Оновити стрічку" })).toHaveProperty("disabled", status === 403);
});
test("MASTER feed network error can retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json({ orders: [order] })));
  show("/master/orders"); expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу");
  await userEvent.click(screen.getByRole("button", { name: "Оновити стрічку" })); expect(await screen.findByLabelText("Ваша пропозиція")).toBeInTheDocument();
});
test.each([" ", "\n\t"])("whitespace offer %j creates no POST", async (message) => {
  const mock = vi.fn().mockResolvedValue(json({ orders: [order] })); vi.stubGlobal("fetch", mock); show("/master/orders");
  await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), message); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Напишіть текст"); expect(mock).toHaveBeenCalledTimes(1);
});
test.each([400, 403, 500])("offer POST %s keeps text and avoids false success", async (status) => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(failure(status));
  vi.stubGlobal("fetch", mock); show("/master/orders");
  await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), response.message); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`); expect(screen.getByLabelText("Ваша пропозиція")).toHaveValue(response.message);
  expect(screen.getByRole("button", { name: "Надіслати пропозицію" })).toHaveProperty("disabled", status === 403);
});
test("duplicate 409 refreshes feed and replaces form with original response", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(failure(409)).mockResolvedValueOnce(json({ orders: [{ ...order, myResponse: response }] }));
  vi.stubGlobal("fetch", mock); show("/master/orders");
  await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), "Повторна пропозиція"); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByText("Пропозицію надіслано")).toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("пропозиція вже існує");
  expect(mock.mock.calls[2]?.[1].method).toBe("GET");
});
test("closed-order 409 removes the order following automatic refresh", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(failure(409)).mockResolvedValueOnce(json({ orders: [] })));
  show("/master/orders"); await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), response.message); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByText(/Відкритих заявок за вашим профілем поки немає/)).toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
test.each(["feed", "offer"])("MASTER %s 401 logs out", async (operation) => {
  const mock = vi.fn(); if (operation === "offer") mock.mockResolvedValueOnce(json({ orders: [order] }));
  mock.mockResolvedValueOnce(failure(401)); vi.stubGlobal("fetch", mock); show("/master/orders");
  if (operation === "offer") { await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), response.message); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" })); }
  expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
test("MASTER dashboard displays assigned ACCEPTED order, link and refreshed CANCELLED history", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { id: "master-user", name: master.name, email: "synthetic@fixit.test", role: "MASTER" } }))
    .mockResolvedValueOnce(json({ orders: [accepted] })).mockResolvedValueOnce(json({ orders: [{ ...accepted, status: "CANCELLED" }] }));
  vi.stubGlobal("fetch", mock); show("/dashboard");
  const section = await screen.findByRole("region", { name: "Призначені заявки" });
  expect(await within(section).findByText("Прийнята")).toBeInTheDocument(); expect(screen.getByRole("link", { name: /Заявки для майстра/ })).toHaveAttribute("href", "/master/orders");
  expect(screen.queryByRole("link", { name: /Мої заявки/ })).not.toBeInTheDocument();
  await userEvent.click(within(section).getByRole("button", { name: "Оновити призначення" })); expect(await within(section).findByText("Скасована")).toBeInTheDocument();
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/master\/orders\/assigned$/);
});
test("CLIENT dashboard never fetches MASTER assignments", async () => {
  const mock = vi.fn().mockResolvedValue(json({ user: { id: "client", name: "Synthetic", email: "client@fixit.test", role: "CLIENT" } }));
  vi.stubGlobal("fetch", mock); show("/dashboard"); await screen.findByRole("link", { name: /Мої заявки/ });
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1)); expect(screen.queryByRole("region", { name: "Призначені заявки" })).not.toBeInTheDocument();
});
test("MASTER conflict refresh failure preserves offer text and both errors for retry", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ orders: [order] })).mockResolvedValueOnce(failure(409, "Пропозиція вже існує"))
    .mockResolvedValueOnce(failure(503, "Стрічка недоступна")).mockResolvedValueOnce(json({ orders: [{ ...order, myResponse: response }] }));
  vi.stubGlobal("fetch", mock); show("/master/orders");
  await userEvent.type(await screen.findByLabelText("Ваша пропозиція"), response.message); await userEvent.click(screen.getByRole("button", { name: "Надіслати пропозицію" }));
  expect(await screen.findByText("Стрічка недоступна")).toBeInTheDocument(); expect(screen.getByText("Пропозиція вже існує")).toBeInTheDocument();
  expect(screen.getByLabelText("Ваша пропозиція")).toHaveValue(response.message);
  await userEvent.click(screen.getByRole("button", { name: "Оновити стрічку" })); expect(await screen.findByText("Пропозицію надіслано")).toBeInTheDocument();
});
test("assignment GET failure has an independent retry in MASTER cabinet", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { id: "master-user", name: master.name, email: "synthetic@fixit.test", role: "MASTER" } }))
    .mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(json({ orders: [] }));
  vi.stubGlobal("fetch", mock); show("/dashboard"); expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 503");
  expect(screen.getByRole("link", { name: /Заявки для майстра/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Оновити призначення" })); expect(await screen.findByText("Призначених заявок поки немає.")).toBeInTheDocument();
});
test("expired assignment GET logs MASTER out", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ user: { id: "master-user", name: master.name, email: "synthetic@fixit.test", role: "MASTER" } })).mockResolvedValueOnce(failure(401));
  vi.stubGlobal("fetch", mock); show("/dashboard"); expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
});
