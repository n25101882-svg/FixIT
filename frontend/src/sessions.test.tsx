import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError, bindApiSession } from "./api";
import { SessionClient } from "./session";
import { AuthProvider, useAuth } from "./auth";
import { App } from "./App";

const user = { id: "synthetic-client", name: "TestClient", role: "CLIENT" as const, email: "synthetic-session@fixit.test" };
const userB = { ...user, id: "synthetic-other", name: "OtherClient" };
const recovered = { accessToken: "synthetic-refreshed-token", user, expiresIn: 900, tokenType: "Bearer" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const error = (status: number) => json({ error: { message: `Synthetic HTTP ${status}` } }, status);
const empty = () => new Response(null, { status: 204 });
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>((done) => { resolve = done; }); return { resolve, promise }; }
function Probe() { const auth = useAuth(), location = useLocation(); return <span data-testid="probe">{auth.status}:{location.pathname}</span>; }
function show(path = "/orders", strict = false) {
  const view = <MemoryRouter initialEntries={[path]}><AuthProvider><App /><Probe /></AuthProvider></MemoryRouter>;
  return render(strict ? <StrictMode>{view}</StrictMode> : view);
}
let unbind: (() => void) | undefined;
function client() { const value = new SessionClient(); value.login("synthetic-old-token", user); unbind = bindApiSession(value); return value; }
afterEach(() => { unbind?.(); unbind = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("bootstrap blocks redirect, recovers current /orders and never uses Web Storage", async () => {
  const pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ orders: [] })); vi.stubGlobal("fetch", mock); show();
  expect(screen.getByRole("status")).toHaveTextContent("Перевіряємо вашу сесію"); expect(screen.getByTestId("probe")).toHaveTextContent("bootstrapping:/orders");
  expect(screen.queryByRole("form", { name: "Вхід" })).not.toBeInTheDocument(); await act(async () => pending.resolve(json(recovered)));
  expect(await screen.findByRole("form", { name: "Нова заявка" })).toBeInTheDocument(); expect(screen.getByTestId("probe")).toHaveTextContent("authenticated:/orders");
  expect(mock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", method: "POST", headers: { "X-FixIT-CSRF": "1" } });
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
});
test("StrictMode mounts still issue one bootstrap refresh", async () => {
  const mock = vi.fn().mockResolvedValueOnce(error(401)); vi.stubGlobal("fetch", mock); show("/dashboard", true);
  expect(await screen.findByRole("form", { name: "Вхід" })).toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(1);
});
test("missing/invalid cookie finishes bootstrap as anonymous with safe details returnTo", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(error(401))); const id = "40000000-0000-4000-8000-000000000091"; show(`/orders/${id}`);
  expect(await screen.findByRole("form", { name: "Вхід" })).toBeInTheDocument(); expect(screen.getByTestId("probe")).toHaveTextContent("anonymous:/login");
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
test.each(["network", 500, 403, 409, 429])("bootstrap %s has retry, no redirect/logout or refresh loop", async (kind) => {
  const mock = vi.fn(); if (kind === "network") mock.mockRejectedValueOnce(new TypeError("offline")); else mock.mockResolvedValueOnce(error(Number(kind)));
  mock.mockResolvedValueOnce(json(recovered)).mockResolvedValueOnce(json({ orders: [] })); vi.stubGlobal("fetch", mock); show();
  expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.getByTestId("probe")).toHaveTextContent("unavailable:/orders"); expect(mock).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Повторити перевірку сесії" })); expect(await screen.findByRole("form", { name: "Нова заявка" })).toBeInTheDocument();
  expect(mock.mock.calls.filter((call) => String(call[0]).endsWith("/auth/logout"))).toHaveLength(0);
});
test("malformed successful refresh is a recoverable server error, not authenticated", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ user }))); show(); expect(await screen.findByRole("alert")).toHaveTextContent("Некоректна відповідь");
});
test("F5 on protected details recovers the same path and current role", async () => {
  const id = "40000000-0000-4000-8000-000000000091";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(recovered)).mockResolvedValueOnce(json({ order: { id, type: "CUSTOM", title: "Recovered details", description: "Synthetic", city: "City", category: "OTHER", status: "OPEN", budget: null, createdAt: "2026-11-16T10:00:00Z", assignedMaster: null, timeline: [] } })));
  show(`/orders/${id}`); expect(await screen.findByRole("article", { name: "Recovered details" })).toBeInTheDocument(); expect(screen.getByTestId("probe")).toHaveTextContent(`authenticated:/orders/${id}`);
});
test("concurrent expired-access API calls share one refresh and retry once with Bearer", async () => {
  const session = client(), pending = deferred();
  const mock = vi.fn((url: string, options: RequestInit) => url.endsWith("/auth/refresh") ? pending.promise
    : Promise.resolve(options.headers && (options.headers as Record<string, string>).Authorization === "Bearer synthetic-old-token" ? error(401) : json({ ok: true })));
  vi.stubGlobal("fetch", mock);
  const requests = [api("/orders", { token: session.token! }), api("/users/me", { token: session.token! })];
  await waitFor(() => expect(mock.mock.calls.filter((c) => c[0].endsWith("/auth/refresh"))).toHaveLength(1));
  pending.resolve(json(recovered)); expect(await Promise.all(requests)).toEqual([{ ok: true }, { ok: true }]);
  expect(session.token).toBe(recovered.accessToken); expect(mock).toHaveBeenCalledTimes(5);
  expect(mock.mock.calls.filter((c) => !c[0].endsWith("/auth/refresh")).every((c) => c[1].credentials === "omit")).toBe(true);
});
test("late 401 after another request refreshed reuses new access token without rotating again", async () => {
  const session = client(), pending = deferred();
  const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(error(401)).mockResolvedValueOnce(json(recovered)).mockImplementation(() => Promise.resolve(json({ ok: true }))); vi.stubGlobal("fetch", mock);
  const late = api("/orders", { token: session.token! }); await api("/users/me", { token: session.token! }); pending.resolve(error(401)); await expect(late).resolves.toEqual({ ok: true });
  expect(mock.mock.calls.filter((c) => String(c[0]).endsWith("/auth/refresh"))).toHaveLength(1);
});
test("401 after the single retry expires memory, with no infinite refresh", async () => {
  const session = client(); const mock = vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(json(recovered)).mockResolvedValueOnce(error(401)); vi.stubGlobal("fetch", mock);
  await expect(api("/orders", { token: session.token! })).rejects.toMatchObject({ status: 401 }); expect(session.getSnapshot().status).toBe("anonymous"); expect(mock).toHaveBeenCalledTimes(3);
});
test.each(["network", 500, 409, 429])("refresh %s during API recovery retains memory and exposes a non-401 failure", async (kind) => {
  const session = client(), mock = vi.fn().mockResolvedValueOnce(error(401));
  if (kind === "network") mock.mockRejectedValueOnce(new TypeError("offline")); else mock.mockResolvedValueOnce(error(Number(kind))); vi.stubGlobal("fetch", mock);
  await expect(api("/orders", { token: session.token! })).rejects.toMatchObject({ status: kind === "network" ? 0 : kind });
  expect(session.token).toBe("synthetic-old-token"); expect(session.getSnapshot().status).toBe("authenticated"); expect(mock).toHaveBeenCalledTimes(2);
});
test("refresh 401 ends recovery without retrying protected data", async () => {
  const session = client(); const mock = vi.fn().mockResolvedValue(error(401)); vi.stubGlobal("fetch", mock);
  await expect(api("/orders", { token: session.token! })).rejects.toBeInstanceOf(ApiError); expect(session.token).toBeNull(); expect(mock).toHaveBeenCalledTimes(2);
});
test("business 403 never refreshes or logs out", async () => {
  const session = client(), mock = vi.fn().mockResolvedValue(error(403)); vi.stubGlobal("fetch", mock);
  await expect(api("/master/orders/assigned", { token: session.token! })).rejects.toMatchObject({ status: 403 }); expect(session.token).toBeTruthy(); expect(mock).toHaveBeenCalledTimes(1);
});
test("old-account successful response is ignored after user changes", async () => {
  const session = client(), pending = deferred(); vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
  const old = api("/orders", { token: session.token! }); session.login("synthetic-other-token", userB); pending.resolve(json({ private: "old-account" }));
  await expect(old).rejects.toMatchObject({ name: "AbortError" }); expect(session.getSnapshot().user?.id).toBe(userB.id);
  await expect(api("/orders", { token: "synthetic-old-token" })).rejects.toMatchObject({ name: "AbortError" });
});
test("aborted original request does not retry after shared refresh", async () => {
  const session = client(), pending = deferred(), controller = new AbortController(); const mock = vi.fn().mockResolvedValueOnce(error(401)).mockReturnValueOnce(pending.promise); vi.stubGlobal("fetch", mock);
  const result = api("/orders", { token: session.token!, signal: controller.signal }); await waitFor(() => expect(mock).toHaveBeenCalledTimes(2)); controller.abort(); pending.resolve(json(recovered));
  await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(mock).toHaveBeenCalledTimes(2);
});
test("logout clears memory immediately, waits for refresh cookie and revokes without resurrection", async () => {
  const session = client(), pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(empty()); vi.stubGlobal("fetch", mock);
  const old = session.refresh(); const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" }); const out = session.logout();
  expect(session.token).toBeNull(); expect(document.cookie).toContain("fixit_logout_pending=1"); pending.resolve(json(recovered)); await rejected; await out;
  expect(session.token).toBeNull(); expect(document.cookie).not.toContain("logout_pending"); expect(mock.mock.calls[1]?.[0]).toMatch(/\/auth\/logout$/);
});
test("failed explicit logout persists only a non-secret intent; next bootstrap retries logout, not refresh", async () => {
  const session = client(); const mock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(empty()); vi.stubGlobal("fetch", mock);
  await expect(session.logout()).rejects.toMatchObject({ status: 0 }); expect(session.token).toBeNull(); expect(document.cookie).toContain("logout_pending=1");
  const next = new SessionClient(); next.bootstrap(); await waitFor(() => expect(next.getSnapshot().status).toBe("anonymous"));
  expect(mock.mock.calls.every((c) => String(c[0]).endsWith("/auth/logout"))).toBe(true); expect(document.cookie).not.toContain("logout_pending");
  expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
});
test("new login waits for logout acknowledgement and then owns the new session", async () => {
  const session = client(), pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({ ...recovered, user: userB })); vi.stubGlobal("fetch", mock);
  const out = session.logout(), signed = session.signIn({ email: userB.email, password: "Synthetic unit password" });
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1)); pending.resolve(empty()); await out; await signed;
  expect(session.getSnapshot().user?.id).toBe(userB.id); expect(mock.mock.calls.map((c) => String(c[0]).split("/").at(-1))).toEqual(["logout", "login"]);
});
test("Web Locks serializes cookie-changing operations", async () => {
  const request = vi.fn((_name: string, _options: unknown, action: () => Promise<unknown>) => action()); vi.stubGlobal("navigator", { locks: { request } });
  const session = client(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(recovered))); await session.refresh(); expect(request).toHaveBeenCalledWith("fixit-auth-cookie", expect.objectContaining({ signal: expect.any(AbortSignal) }), expect.any(Function));
});
test("provider unmount ignores a late bootstrap response", async () => {
  const pending = deferred(); vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise)); const view = show(); view.unmount();
  await act(async () => pending.resolve(json(recovered))); expect(window.localStorage.length).toBe(0);
});
test("an auth fetch deadline is recoverable and never treated as explicit logout", async () => {
  const controller = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new DOMException("Deadline", "TimeoutError"))))));
  const session = new SessionClient(); const run = session.refresh(); const rejected = expect(run).rejects.toMatchObject({ status: 0 });
  controller.abort(); await rejected; expect(session.getSnapshot().status).toBe("unavailable"); expect(document.cookie).not.toContain("logout_pending");
});
test("concurrent sign-in and duplicate logout each use one cookie-changing request", async () => {
  const session = new SessionClient(), pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(empty()); vi.stubGlobal("fetch", mock);
  const first = session.signIn({ email: user.email, password: "Synthetic" }); const second = session.signIn({ email: user.email, password: "Synthetic" }); expect(second).toBe(first);
  pending.resolve(json(recovered)); await first; const out = session.logout(); expect(session.logout()).toBe(out); await out; expect(mock).toHaveBeenCalledTimes(2);
});
test("logout during pending login rejects stale credentials then revokes its resulting cookie", async () => {
  const session = new SessionClient(), pending = deferred(); const mock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(empty()); vi.stubGlobal("fetch", mock);
  const signed = session.signIn({ email: user.email, password: "Synthetic" }); await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
  const rejected = expect(signed).rejects.toMatchObject({ name: "AbortError" }); const out = session.logout(); pending.resolve(json(recovered)); await rejected; await out; expect(session.token).toBeNull(); expect(mock).toHaveBeenCalledTimes(2);
});
test("a refresh restoring another account invalidates prior account requests", async () => {
  const session = client(); const mock = vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(json({ ...recovered, user: userB })); vi.stubGlobal("fetch", mock);
  await expect(api("/orders", { token: session.token! })).rejects.toMatchObject({ name: "AbortError" }); expect(session.getSnapshot().user?.id).toBe(userB.id);
});
test("cross-tab messages contain no credentials and invalidate old-account state", async () => {
  const created: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  class Channel { onmessage: ((event: MessageEvent) => void) | null = null; postMessage = vi.fn(); close = vi.fn(); constructor() { created.push(this); } }
  vi.stubGlobal("BroadcastChannel", Channel); const session = client(); session.attach(); const c = created[0]!;
  c.onmessage!(new MessageEvent("message", { data: "ignored" })); expect(session.token).toBeTruthy();
  c.onmessage!(new MessageEvent("message", { data: "logout" })); expect(session.token).toBeNull();
  const mock = vi.fn().mockResolvedValue(json({ ...recovered, user: userB })); vi.stubGlobal("fetch", mock);
  c.onmessage!(new MessageEvent("message", { data: "account-changed" })); await waitFor(() => expect(session.getSnapshot().user?.id).toBe(userB.id));
  session.detach(); await Promise.resolve(); expect(c.close).toHaveBeenCalledTimes(1);
});
test("account-change broadcast replaces a stale queued refresh instead of hanging bootstrap", async () => {
  const channels: { onmessage: ((event: MessageEvent) => void) | null }[] = [];
  class Channel { onmessage: ((event: MessageEvent) => void) | null = null; postMessage() {} close() {} constructor() { channels.push(this); } }
  vi.stubGlobal("BroadcastChannel", Channel);
  const queue: { action: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (value: unknown) => void }[] = [];
  vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, action: () => Promise<unknown>) => new Promise((resolve, reject) => queue.push({ action, resolve, reject })) } });
  const session = client(); session.attach(); const old = session.refresh(); const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
  channels[0]!.onmessage!(new MessageEvent("message", { data: "account-changed" })); expect(queue).toHaveLength(2);
  for (const item of queue) { try { if (item === queue[1]) vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...recovered, user: userB }))); item.resolve(await item.action()); } catch (error) { item.reject(error); } }
  await rejected; await waitFor(() => expect(session.getSnapshot().user?.id).toBe(userB.id)); session.detach();
});
