import { ApiError, rawApi, type LoginResponse, type User } from "./api";

type Status = "bootstrapping" | "authenticated" | "anonymous" | "unavailable";
export interface SessionSnapshot { token: string | null; user: User | null; status: Status; sessionExpired: boolean; error: string }
const markerName = import.meta.env.PROD ? "__Host-fixit_logout_pending" : "fixit_logout_pending";
function pendingLogout() { return document.cookie.split(";").some((part) => part.trim() === `${markerName}=1`); }
function marker(pending: boolean) {
  document.cookie = `${markerName}=${pending ? "1" : ""}; Path=/; SameSite=Strict; Max-Age=${pending ? 604800 : 0}${import.meta.env.PROD ? "; Secure" : ""}`;
}
async function cookieLock<T>(action: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request("fixit-auth-cookie", { signal: AbortSignal.timeout(12000) }, action) : action();
}
export class SessionClient {
  epoch = 0;
  token: string | null = null;
  attached = false;
  private snapshot: SessionSnapshot;
  private listeners = new Set<() => void>();
  private flight: Promise<string> | null = null;
  private logoutFlight: Promise<void> | null = null;
  private loginFlight: Promise<LoginResponse> | null = null;
  private channel: BroadcastChannel | null = null;
  constructor(public readonly autoRecover = true) {
    this.snapshot = { token: null, user: null, status: autoRecover ? "bootstrapping" : "anonymous", sessionExpired: false, error: "" };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(change: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }; this.token = this.snapshot.token;
    for (const listener of this.listeners) listener();
  }
  private check(epoch: number) { if (epoch !== this.epoch) throw new DOMException("Session changed", "AbortError"); }
  login = (token: string, user: User | null = null) => {
    this.epoch++; this.update({ token, user, status: "authenticated", sessionExpired: false, error: "" });
  };
  expired = () => { this.epoch++; this.update({ token: null, user: null, status: "anonymous", sessionExpired: true, error: "" }); };
  refresh = (): Promise<string> => {
    if (this.flight) return this.flight;
    if (pendingLogout()) return Promise.reject(new ApiError(401, "Вихід ще не підтверджено сервером."));
    const epoch = this.epoch;
    const run = cookieLock(async () => {
      this.check(epoch);
      const data = await rawApi<LoginResponse>("/auth/refresh", { method: "POST", body: {} });
      this.check(epoch);
      if (!data.accessToken || !data.user) throw new ApiError(502, "Некоректна відповідь відновлення сесії.");
      if (this.snapshot.user && this.snapshot.user.id !== data.user.id) this.epoch++;
      this.update({ token: data.accessToken, user: data.user, status: "authenticated", error: "", sessionExpired: false });
      return data.accessToken;
    }).catch((error: unknown) => {
      this.check(epoch);
      if (error instanceof ApiError && error.status === 401) this.expired();
      else if (!this.token) this.update({ status: "unavailable", error: error instanceof Error ? error.message : "Не вдалося перевірити сесію." });
      throw error;
    });
    this.flight = run;
    void run.finally(() => { if (this.flight === run) this.flight = null; }).catch(() => {});
    return run;
  };
  bootstrap = () => {
    if (!this.autoRecover || this.token) return;
    if (pendingLogout()) { void this.logout().catch(() => {}); return; }
    this.update({ status: "bootstrapping", error: "" });
    void this.refresh().catch(() => {});
  };
  signIn = (body: { email: string; password: string }): Promise<LoginResponse> => {
    if (this.loginFlight) return this.loginFlight;
    const run = (async () => {
      if (pendingLogout()) await this.logout();
      if (this.logoutFlight) await this.logoutFlight;
      await this.flight?.catch(() => {});
      const epoch = ++this.epoch;
      const data = await cookieLock(async () => { this.check(epoch); return rawApi<LoginResponse>("/auth/login", { method: "POST", body }); });
      this.check(epoch); this.login(data.accessToken, data.user);
      this.channel?.postMessage("account-changed"); return data;
    })();
    this.loginFlight = run;
    void run.finally(() => { if (this.loginFlight === run) this.loginFlight = null; }).catch(() => {});
    return run;
  };
  logout = (expired = false): Promise<void> => {
    if (expired) { this.expired(); return Promise.resolve(); }
    if (!this.autoRecover) {
      this.epoch++; this.update({ token: null, user: null, status: "anonymous", sessionExpired: false, error: "" });
      return Promise.resolve();
    }
    if (this.logoutFlight) return this.logoutFlight;
    const wait = [this.flight, this.loginFlight];
    this.epoch++; marker(true);
    this.update({ token: null, user: null, status: "anonymous", sessionExpired: false, error: "" });
    this.channel?.postMessage("logout");
    const run = (async () => {
      await Promise.allSettled(wait.filter(Boolean));
      await cookieLock(() => rawApi<void>("/auth/logout", { method: "POST", body: {} }));
      marker(false);
      this.update({ token: null, user: null, status: "anonymous", error: "" });
    })().catch((error: unknown) => {
      this.update({ status: "unavailable", error: "Вихід не підтверджено сервером. Повторіть, коли з’явиться мережа." });
      throw error;
    });
    this.logoutFlight = run;
    void run.finally(() => { if (this.logoutFlight === run) this.logoutFlight = null; }).catch(() => {});
    return run;
  };
  attach() {
    this.attached = true;
    if (this.autoRecover && typeof window.BroadcastChannel === "function" && !this.channel) {
      this.channel = new window.BroadcastChannel("fixit-session");
      this.channel.onmessage = (event: MessageEvent) => {
        if (event.data === "logout" || event.data === "account-changed") {
          this.epoch++; this.update({ token: null, user: null, status: event.data === "logout" ? "anonymous" : "bootstrapping", error: "" });
          if (event.data === "account-changed") { this.flight = null; this.bootstrap(); }
        }
      };
    }
  }
  detach() {
    this.attached = false;
    queueMicrotask(() => { if (!this.attached) { this.epoch++; this.channel?.close(); this.channel = null; } });
  }
}
