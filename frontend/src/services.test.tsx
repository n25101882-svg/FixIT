import { useEffect, useState, type ReactNode } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider, useAuth } from "./auth";

const profile = { id: "public-profile", name: "Синтетичний майстер", city: "Тестоград", category: "TECH_REPAIR", description: "Синтетичний профіль" };
const service = { id: "synthetic-service", title: "Синтетична послуга", category: "PLUMBING", description: "Синтетичний опис послуги", priceEstimate: "250.50", isActive: true };
const page = { services: [{ ...service, master: profile }], page: 1, limit: 12, total: 1, totalPages: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const error = (status: number, fields?: Record<string, string>) => json({ error: { message: `Помилка ${status}`, fields } }, status);
function Session({ children }: { children: ReactNode }) {
  const { login } = useAuth(); const [ready, setReady] = useState(false);
  useEffect(() => { login("synthetic-services-token"); setReady(true); }, [login]); return ready ? children : null;
}
function show(path = "/master/services", authenticated = true) {
  render(<MemoryRouter initialEntries={[path]}><AuthProvider recoverSession={false}>{authenticated ? <Session><App /></Session> : <App />}</AuthProvider></MemoryRouter>);
}
function management(services: unknown[] = [service]) {
  const mock = vi.fn().mockResolvedValueOnce(json({ profile })).mockResolvedValueOnce(json({ services })); vi.stubGlobal("fetch", mock); return mock;
}
async function fillService(price = "") {
  await userEvent.type(await screen.findByLabelText("Назва послуги"), "Нова синтетична послуга");
  await userEvent.selectOptions(screen.getByLabelText("Категорія послуги"), "ELECTRICAL");
  await userEvent.type(screen.getByLabelText("Опис послуги"), "Опис нової послуги");
  if (price) await userEvent.type(screen.getByLabelText(/Орієнтовна ціна/), price);
}
afterEach(() => vi.unstubAllGlobals());

test("MASTER management is protected for guests", () => { show("/master/services", false); expect(screen.getByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument(); });
test("own profile and services load with JWT; no identity/approval editors exist", async () => {
  const mock = management(); show(); expect(await screen.findByRole("form", { name: "Мій профіль майстра" })).toBeInTheDocument();
  expect(screen.getByLabelText("Місто профілю")).toHaveValue(profile.city); expect(screen.getByRole("article", { name: service.title })).toBeInTheDocument();
  for (const call of mock.mock.calls) expect(call[1].headers.Authorization).toBe("Bearer synthetic-services-token");
  expect(screen.queryByLabelText(/Email|Пароль|isApproved/)).not.toBeInTheDocument();
});
test("201 creates a service and updates the list without F5, preserving null price", async () => {
  const created = { ...service, id: "new-service", title: "Нова синтетична послуга", category: "ELECTRICAL", description: "Опис нової послуги", priceEstimate: null };
  const mock = management([]); mock.mockResolvedValueOnce(json({ service: created }, 201)); show(); await fillService();
  await userEvent.click(screen.getByRole("button", { name: "Створити послугу" }));
  expect(await screen.findByText("Послугу створено.")).toBeInTheDocument(); expect(screen.getByRole("article", { name: created.title })).toHaveTextContent("Ціна не вказана");
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({ title: created.title, category: created.category, description: created.description, priceEstimate: null });
  expect(mock.mock.calls[2]?.[1].method).toBe("POST"); expect(screen.getByLabelText("Назва послуги")).toHaveValue("");
});
test("editing service sends only allowed fields and exact decimal string", async () => {
  const updated = { ...service, title: "Нова назва", priceEstimate: "0.00" }; const mock = management(); mock.mockResolvedValueOnce(json({ service: updated })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Редагувати" }));
  const title = screen.getByLabelText("Назва послуги"); await userEvent.clear(title); await userEvent.type(title, updated.title);
  const price = screen.getByLabelText(/Орієнтовна ціна/); await userEvent.clear(price); await userEvent.type(price, "0");
  await userEvent.click(screen.getByRole("button", { name: "Зберегти послугу" }));
  expect(await screen.findByRole("article", { name: updated.title })).toHaveTextContent("0.00 грн");
  expect(mock.mock.calls[2]?.[0]).toMatch(/\/master\/services\/synthetic-service$/);
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({ title: updated.title, category: service.category, description: service.description, priceEstimate: "0" });
});
test("clearing optional service description/price sends null rather than zero", async () => {
  const mock = management(); mock.mockResolvedValueOnce(json({ service: { ...service, description: null, priceEstimate: null } })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Редагувати" })); await userEvent.clear(screen.getByLabelText("Опис послуги")); await userEvent.clear(screen.getByLabelText(/Орієнтовна ціна/));
  await userEvent.click(screen.getByRole("button", { name: "Зберегти послугу" })); await screen.findByText("Послугу оновлено.");
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toMatchObject({ description: null, priceEstimate: null });
});
test("hide and reactivate use PATCH isActive and update the card", async () => {
  const mock = management(); mock.mockResolvedValueOnce(json({ service: { ...service, isActive: false } })).mockResolvedValueOnce(json({ service })); show();
  await userEvent.click(await screen.findByRole("button", { name: "Приховати" })); expect(await screen.findByText("Прихована")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Активувати" })); expect(await screen.findByText("Послугу активовано.")).toBeInTheDocument();
  expect(mock.mock.calls.slice(2).map((call) => JSON.parse(call[1].body))).toEqual([{ isActive: false }, { isActive: true }]);
});
test("cancelling edits sends no mutation", async () => {
  const mock = management(); show(); await userEvent.click(await screen.findByRole("button", { name: "Редагувати" }));
  await userEvent.click(screen.getByRole("button", { name: "Скасувати редагування" })); expect(screen.getByRole("heading", { name: "Нова послуга" })).toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(2);
});
test("service field errors are accessible and submitted values survive 400", async () => {
  const mock = management(); mock.mockResolvedValueOnce(error(400, { title: "Виправте назву", priceEstimate: "Виправте ціну" })); show(); await fillService("1.234");
  await userEvent.click(screen.getByRole("button", { name: "Створити послугу" })); await screen.findByRole("alert");
  expect(screen.getByLabelText("Назва послуги")).toHaveAccessibleDescription("Виправте назву"); expect(screen.getByLabelText(/Орієнтовна ціна/)).toHaveAccessibleDescription("Виправте ціну");
  expect(screen.getByLabelText("Назва послуги")).toHaveValue("Нова синтетична послуга"); expect(screen.getByLabelText(/Орієнтовна ціна/)).toHaveValue("1.234");
});
test("profile update uses only city/category/description, preserving independent service category", async () => {
  const updated = { ...profile, city: "Нове місто", category: "OTHER", description: null };
  const mock = management(); mock.mockResolvedValueOnce(json({ profile: updated })); show();
  await screen.findByLabelText("Місто профілю"); await userEvent.clear(screen.getByLabelText("Місто профілю")); await userEvent.type(screen.getByLabelText("Місто профілю"), updated.city);
  await userEvent.selectOptions(screen.getByLabelText("Основна категорія"), "OTHER"); await userEvent.clear(screen.getByLabelText("Опис профілю"));
  await userEvent.click(screen.getByRole("button", { name: "Зберегти профіль" })); expect(await screen.findByText("Профіль оновлено.")).toBeInTheDocument();
  expect(JSON.parse(mock.mock.calls[2]?.[1].body)).toEqual({ city: updated.city, category: "OTHER", description: null });
  expect(within(screen.getByRole("article", { name: service.title })).getByText("Сантехніка")).toBeInTheDocument();
});
test("profile field error preserves dirty input through explicit synchronization", async () => {
  const mock = management(); mock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json({ profile })).mockResolvedValueOnce(json({ services: [service] })); show();
  await screen.findByLabelText("Місто профілю"); await userEvent.clear(screen.getByLabelText("Місто профілю")); await userEvent.type(screen.getByLabelText("Місто профілю"), "Мої незбережені дані");
  await userEvent.click(screen.getByRole("button", { name: "Зберегти профіль" })); expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу");
  expect(screen.getByRole("button", { name: "Зберегти профіль" })).toBeDisabled(); await userEvent.click(screen.getByRole("button", { name: "Оновити мої дані" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Зберегти профіль" })).toBeEnabled()); expect(screen.getByLabelText("Місто профілю")).toHaveValue("Мої незбережені дані");
});
test("profile 400 displays a field message and retains changed description", async () => {
  const mock = management(); mock.mockResolvedValueOnce(error(400, { description: "Виправте опис" })); show();
  await userEvent.type(await screen.findByLabelText("Опис профілю"), " додані дані"); await userEvent.click(screen.getByRole("button", { name: "Зберегти профіль" }));
  await screen.findByRole("alert"); expect(screen.getByLabelText("Опис профілю")).toHaveAccessibleDescription("Виправте опис"); expect(screen.getByLabelText("Опис профілю")).toHaveValue(profile.description + " додані дані");
});
test("a pending save disables repeated submission and all conflicting mutations", async () => {
  const mock = management(); mock.mockImplementationOnce(() => new Promise(() => {})); show(); await fillService(); await userEvent.dblClick(screen.getByRole("button", { name: "Створити послугу" }));
  expect(screen.getByRole("button", { name: "Створити послугу" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Приховати" })).toBeDisabled(); expect(mock).toHaveBeenCalledTimes(3);
});
test.each([401, 403])("management GET %s enforces session/role without forms", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(error(status)))); show();
  if (status === 401) expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  else { expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 403"); expect(screen.queryByRole("form")).not.toBeInTheDocument(); }
});
test.each([401, 403])("management mutation %s logs out or removes forbidden forms", async (status) => {
  const mock = management(); mock.mockResolvedValueOnce(error(status)); show(); await userEvent.click(await screen.findByRole("button", { name: "Приховати" }));
  if (status === 401) expect(await screen.findByRole("heading", { name: /Раді бачити знову/ })).toBeInTheDocument();
  else { await screen.findByText("Помилка 403"); expect(screen.queryByRole("form")).not.toBeInTheDocument(); }
});
test("management GET error has Loading/Error/retry/Empty states", async () => {
  const mock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(json({ profile })).mockResolvedValueOnce(json({ services: [] }));
  vi.stubGlobal("fetch", mock); show(); expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу");
  await userEvent.click(screen.getByRole("button", { name: "Оновити мої дані" })); expect(await screen.findByText("Послуг поки немає. Створіть першу.")).toBeInTheDocument();
});
test.each([409, 503])("mutation %s preserves service inputs and requires GET before retry", async (status) => {
  const mock = management(); mock.mockResolvedValueOnce(error(status)); show(); await fillService("25.50"); await userEvent.click(screen.getByRole("button", { name: "Створити послугу" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(`Помилка ${status}`); expect(screen.getByLabelText("Назва послуги")).toHaveValue("Нова синтетична послуга");
  expect(screen.getByRole("button", { name: "Створити послугу" })).toBeDisabled();
});

test("guest root opens catalog and public GET never sends JWT", async () => {
  const mock = vi.fn().mockResolvedValue(json(page)); vi.stubGlobal("fetch", mock); show("/", false);
  expect(await screen.findByRole("article", { name: service.title })).toBeInTheDocument(); expect(mock.mock.calls[0]?.[0]).toMatch(/\/catalog\/services/);
  expect(mock.mock.calls[0]?.[1].headers.Authorization).toBeUndefined(); expect(screen.getByRole("button", { name: "Замовити послугу" })).toBeEnabled();
  expect(mock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
});
test("catalog shows nullable price, separate categories and no private fields", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...page, services: [{ ...service, priceEstimate: null, description: null, master: { ...profile, email: "private@fixit.test", passwordHash: "private-hash" } }] })));
  show("/catalog", false); const card = await screen.findByRole("article", { name: service.title }); expect(card).toHaveTextContent("Ціна за домовленістю"); expect(card).toHaveTextContent("Опис послуги не вказано.");
  expect(card).toHaveTextContent("Сантехніка"); expect(screen.queryByText("private@fixit.test")).not.toBeInTheDocument(); expect(screen.queryByText("private-hash")).not.toBeInTheDocument();
});
test("catalog has distinct Loading and Empty states", async () => {
  let resolve!: (response: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  show("/catalog", false); expect(await screen.findByText("Завантажуємо послуги…")).toBeInTheDocument();
  resolve(json({ ...page, services: [], total: 0, totalPages: 0 })); expect(await screen.findByText(/Послуг за цими умовами поки немає/)).toBeInTheDocument();
});
test("search/city/category are sent to the server rather than filtering browser records", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ ...page, services: [], total: 0, totalPages: 0 })); vi.stubGlobal("fetch", mock); show("/catalog", false);
  await screen.findByRole("article"); await userEvent.type(screen.getByRole("textbox", { name: "Пошук послуг" }), "Ремонт крана"); await userEvent.type(screen.getByLabelText("Місто"), "Київ"); await userEvent.selectOptions(screen.getByLabelText("Категорія"), "PLUMBING");
  await userEvent.click(screen.getByRole("button", { name: "Знайти послуги" })); await screen.findByText(/Послуг за цими умовами поки немає/);
  const url = new URL(mock.mock.calls[1]?.[0]); expect(Object.fromEntries(url.searchParams)).toEqual({ q: "Ремонт крана", city: "Київ", category: "PLUMBING" });
});
test("direct catalog links restore filters and pagination in URL survives navigation", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json({ ...page, total: 3, totalPages: 3, limit: 1 })).mockResolvedValueOnce(json({ ...page, page: 2, total: 3, totalPages: 3, limit: 1 })); vi.stubGlobal("fetch", mock);
  show("/catalog?city=Test&category=PLUMBING&q=Repair&limit=1", false); await screen.findByRole("article");
  expect(screen.getByLabelText("Місто")).toHaveValue("Test"); expect(screen.getByRole("textbox", { name: "Пошук послуг" })).toHaveValue("Repair");
  await userEvent.click(screen.getByRole("button", { name: "Наступна" })); expect(await screen.findByText("Сторінка 2 з 3")).toBeInTheDocument();
  const url = new URL(mock.mock.calls[1]?.[0]); expect(url.searchParams.get("page")).toBe("2"); expect(url.searchParams.get("city")).toBe("Test");
});
test("public API errors retry while retaining filters and showing field validation", async () => {
  const mock = vi.fn().mockResolvedValueOnce(error(400, { q: "Виправте пошук" })).mockResolvedValueOnce(json(page)); vi.stubGlobal("fetch", mock); show("/catalog?q=Repair", false);
  expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 400"); expect(screen.getByRole("textbox", { name: "Пошук послуг" })).toHaveAccessibleDescription("Виправте пошук");
  await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" })); expect(await screen.findByRole("article")).toBeInTheDocument(); expect(screen.getByRole("textbox", { name: "Пошук послуг" })).toHaveValue("Repair");
});
test("public network error is recoverable without redirecting to login", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json(page))); show("/catalog", false);
  expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте мережу"); await userEvent.click(screen.getByRole("button", { name: "Оновити каталог" })); expect(await screen.findByRole("article")).toBeInTheDocument();
});
test("guest navigates to master profile and active services without login", async () => {
  const mock = vi.fn().mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json({ ...page, master: profile, services: [service] })); vi.stubGlobal("fetch", mock); show("/catalog", false);
  await userEvent.click(await screen.findByRole("link", { name: `Майстер: ${profile.name}` })); expect(await screen.findByRole("heading", { name: profile.name })).toBeInTheDocument(); expect(screen.getByText(profile.description)).toBeInTheDocument();
  expect(mock.mock.calls[1]?.[0]).toMatch(/\/catalog\/masters\/public-profile/); expect(mock.mock.calls[1]?.[1].headers.Authorization).toBeUndefined();
});
test("direct master URL is public and handles null profile description/zero price", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...page, master: { ...profile, description: null }, services: [{ ...service, priceEstimate: "0.00" }] })));
  show("/masters/public-profile", false); expect(await screen.findByRole("heading", { name: profile.name })).toBeInTheDocument(); expect(screen.getByText("Майстер ще не додав опис.")).toBeInTheDocument(); expect(screen.getByText("0,00 грн")).toBeInTheDocument();
});
test("public master Empty and 404 are distinct states", async () => {
  const mock = vi.fn().mockResolvedValueOnce(error(404)).mockResolvedValueOnce(json({ ...page, master: profile, services: [], total: 0, totalPages: 0 })); vi.stubGlobal("fetch", mock); show("/masters/unknown", false);
  expect(await screen.findByRole("alert")).toHaveTextContent("Помилка 404"); await userEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" })); expect(await screen.findByText("Активних послуг поки немає.")).toBeInTheDocument();
});
test("stale catalog response cannot replace the newest search result", async () => {
  let resolve!: (response: Response) => void;
  const mock = vi.fn().mockResolvedValueOnce(json(page)).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValueOnce(json({ ...page, services: [], total: 0, totalPages: 0 })); vi.stubGlobal("fetch", mock); show("/catalog", false);
  await screen.findByRole("article"); await userEvent.type(screen.getByRole("textbox", { name: "Пошук послуг" }), "old"); await userEvent.click(screen.getByRole("button", { name: "Знайти послуги" }));
  // Public navigation may change URL while an earlier request is in flight.
  await userEvent.click(screen.getByRole("link", { name: "Каталог" }));
  await screen.findByText(/Послуг за цими умовами поки немає/); resolve(json(page));
  await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
});
