export interface User {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "CLIENT" | "MASTER";
}
export interface LoginResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: User;
}
export type ServiceCategory = "TECH_REPAIR" | "PLUMBING" | "ELECTRICAL" | "OTHER";
interface RegistrationFields {
  email: string;
  password: string;
  passwordConfirmation: string;
  name: string;
}
export type RegistrationRequest = RegistrationFields & (
  | { role: "CLIENT" }
  | {
      role: "MASTER";
      city: string;
      category: ServiceCategory;
      profileDescription: string;
      serviceTitle: string;
      serviceDescription: string;
      priceEstimate?: string;
    }
);
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}
const apiUrl = (
  import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? "/api/v1" : "http://127.0.0.1:3000/api/v1")
).replace(/\/$/, "");

export async function rawApi<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const cookieAuth = /^\/auth\/(login|register|refresh|logout)$/.test(path);
  const deadline = cookieAuth ? AbortSignal.timeout(10000) : undefined;
  const signal = options.signal && deadline ? AbortSignal.any([options.signal, deadline]) : options.signal ?? deadline;
  let response: Response;
  try {
    response = await fetch(apiUrl + path, {
      method: options.method ?? "GET",
      credentials: cookieAuth ? "include" : "omit",
      headers: {
        ...(cookieAuth ? { "X-FixIT-CSRF": "1" } : {}),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" && (!deadline?.aborted || options.signal?.aborted))
      throw error;
    throw new ApiError(
      0,
      "Не вдалося з’єднатися з FixIT. Перевірте мережу та спробуйте ще раз.",
    );
  }
  if (response.status === 204 && response.ok) return undefined as T;
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "Не вдалося прочитати відповідь сервера.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.error?.message ?? "Не вдалося виконати запит.",
      data.error?.fields,
    );
  }
  return data as T;
}

export interface ApiSession {
  token: string | null;
  epoch: number;
  autoRecover: boolean;
  refresh: () => Promise<string>;
  expired: () => void;
}
let currentSession: ApiSession | null = null;
export function bindApiSession(session: ApiSession) {
  currentSession = session;
  return () => { if (currentSession === session) currentSession = null; };
}
export async function api<T>(path: string, options: Parameters<typeof rawApi>[1] = {}): Promise<T> {
  const session = options.token ? currentSession : null;
  const epoch = session?.epoch;
  const check = () => {
    if (options.signal?.aborted || (session && (currentSession !== session || session.epoch !== epoch)))
      throw new DOMException("Request belongs to an earlier session", "AbortError");
  };
  if (session && session.token !== options.token) throw new DOMException("Stale access token", "AbortError");
  try { const data = await rawApi<T>(path, options); check(); return data; }
  catch (error) {
    check();
    if (!(error instanceof ApiError) || error.status !== 401 || !session?.autoRecover || path.startsWith("/auth/")) throw error;
    const token = session.token !== options.token && session.token ? session.token : await session.refresh();
    check();
    try { const data = await rawApi<T>(path, { ...options, token }); check(); return data; }
    catch (retryError) {
      check();
      if (retryError instanceof ApiError && retryError.status === 401) session.expired();
      throw retryError;
    }
  }
}
