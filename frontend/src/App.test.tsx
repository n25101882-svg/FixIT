import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthProvider } from "./auth";

const user = {
  id: "synthetic-user",
  email: "synthetic@fixit.test",
  name: "Тестова користувачка",
  role: "CLIENT",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function renderApp(path = "/login") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider recoverSession={false}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
async function fillLogin() {
  const actions = userEvent.setup();
  await actions.type(screen.getByLabelText("Email"), user.email);
  await actions.type(
    screen.getByLabelText("Пароль"),
    "Synthetic test password",
  );
  await actions.click(screen.getByRole("button", { name: "Увійти" }));
  return actions;
}
async function fillRegistration(actions: ReturnType<typeof userEvent.setup>) {
  await actions.type(screen.getByLabelText("Ім’я"), user.name);
  await actions.type(screen.getByLabelText("Email"), user.email);
  await actions.type(screen.getByLabelText("Пароль"), "Synthetic test password");
  await actions.type(screen.getByLabelText("Підтвердження пароля"), "Synthetic test password");
}
async function fillMaster(actions: ReturnType<typeof userEvent.setup>) {
  await actions.click(screen.getByRole("radio", { name: /Майстер/ }));
  await actions.type(screen.getByLabelText("Місто"), "Тестоград");
  await actions.selectOptions(screen.getByLabelText("Категорія"), "PLUMBING");
  await actions.type(screen.getByLabelText("Опис профілю"), "Синтетичний досвід майстра");
  await actions.type(screen.getByLabelText("Назва першої послуги"), "Синтетична послуга");
  await actions.type(screen.getByLabelText("Опис першої послуги"), "Опис синтетичної послуги");
}
afterEach(() => vi.unstubAllGlobals());

describe("authentication navigation", () => {
  test("redirects an unauthenticated dashboard visitor to login", () => {
    renderApp("/dashboard");
    expect(
      screen.getByRole("heading", { name: /Раді бачити знову/ }),
    ).toBeInTheDocument();
  });
  test("logs in, requests users/me with a bearer token, displays the profile and logs out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ accessToken: "test-access-token", user }))
      .mockResolvedValueOnce(json({ user }));
    vi.stubGlobal("fetch", fetchMock);
    renderApp();
    const actions = await fillLogin();
    expect(
      await screen.findByRole("heading", { name: user.name }),
    ).toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeInTheDocument();
    expect(screen.getByText("CLIENT")).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/api\/v1\/users\/me$/);
    expect(fetchMock.mock.calls[1]?.[1].headers.Authorization).toBe(
      "Bearer test-access-token",
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    await actions.click(screen.getByRole("button", { name: /Вийти/ }));
    expect(
      screen.getByRole("heading", { name: /Раді бачити знову/ }),
    ).toBeInTheDocument();
  });
  test("displays invalid-credentials errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { message: "Неправильний email або пароль." } }, 401),
        ),
    );
    renderApp();
    await fillLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Неправильний email або пароль.",
    );
  });
  test("displays network failures without crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network failed")),
    );
    renderApp();
    await fillLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не вдалося з’єднатися",
    );
  });
  test("returns to login when users/me rejects an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ accessToken: "expired-token", user }))
        .mockResolvedValueOnce(
          json({ error: { message: "Unauthorized" } }, 401),
        ),
    );
    renderApp();
    await fillLogin();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Сесія завершилася"),
    );
    expect(screen.getByRole("button", { name: "Увійти" })).toBeInTheDocument();
  });
  test("registers a MASTER and moves to login without storing a token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ user: { ...user, role: "MASTER" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await fillMaster(actions);
    await actions.click(
      screen.getByRole("button", { name: "Створити акаунт" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Акаунт створено",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      email: user.email, name: user.name, password: "Synthetic test password",
      passwordConfirmation: "Synthetic test password", role: "MASTER", city: "Тестоград",
      category: "PLUMBING", profileDescription: "Синтетичний досвід майстра",
      serviceTitle: "Синтетична послуга", serviceDescription: "Опис синтетичної послуги",
    });
    expect(
      screen.queryByRole("radio", { name: /Адміністратор/ }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveValue(user.email),
    );
  });
  test("shows server validation errors alongside the registration field", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(
            {
              error: {
                message: "Цей email уже зареєстрований.",
                fields: { email: "Оберіть інший email." },
              },
            },
            409,
          ),
        ),
    );
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await actions.click(
      screen.getByRole("button", { name: "Створити акаунт" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Цей email уже зареєстрований.",
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText("Оберіть інший email.")).toBeInTheDocument();
  });
  test("MASTER fields are conditional and are never sent for CLIENT after a role switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ user }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    expect(screen.queryByLabelText("Місто")).not.toBeInTheDocument();
    await fillRegistration(actions);
    await fillMaster(actions);
    await actions.type(screen.getByLabelText(/Орієнтовна ціна/), "123.40");
    await actions.click(screen.getByRole("radio", { name: /Клієнт/ }));
    expect(screen.queryByLabelText("Опис профілю")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Назва першої послуги")).not.toBeInTheDocument();
    await actions.click(screen.getByRole("button", { name: "Створити акаунт" }));
    await screen.findByRole("status");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      email: user.email, name: user.name, password: "Synthetic test password",
      passwordConfirmation: "Synthetic test password", role: "CLIENT",
    });
  });
  test("optional MASTER price is sent as the exact string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ user: { ...user, role: "MASTER" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await fillMaster(actions);
    await actions.type(screen.getByLabelText(/Орієнтовна ціна/), "123.40");
    await actions.click(screen.getByRole("button", { name: "Створити акаунт" }));
    await screen.findByRole("status");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).priceEstimate).toBe("123.40");
  });
  test("MASTER validation feedback remains attached to the fields without navigating", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: {
      message: "Перевірте поля форми.", fields: { city: "Перевірте місто.", serviceDescription: "Уточніть опис послуги." },
    } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await fillMaster(actions);
    await actions.click(screen.getByRole("button", { name: "Створити акаунт" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте поля форми.");
    expect(screen.getByLabelText("Місто")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Опис першої послуги")).toHaveAttribute("aria-describedby", "serviceDescription-error");
    expect(screen.getByText("Уточніть опис послуги.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Майстер/ })).toBeChecked();
  });
  test("mismatched password confirmation prevents the request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await actions.clear(screen.getByLabelText("Підтвердження пароля"));
    await actions.type(screen.getByLabelText("Підтвердження пароля"), "Different test password");
    await actions.click(screen.getByRole("button", { name: "Створити акаунт" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Перевірте підтвердження пароля.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Підтвердження пароля")).toHaveAttribute("aria-invalid", "true");
  });
  test("required MASTER fields block an incomplete submission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const actions = userEvent.setup();
    renderApp("/register");
    await fillRegistration(actions);
    await actions.click(screen.getByRole("radio", { name: /Майстер/ }));
    await actions.click(screen.getByRole("button", { name: "Створити акаунт" }));
    expect(screen.getByLabelText("Місто")).toBeInvalid();
    expect(screen.getByLabelText("Опис першої послуги")).toBeRequired();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
