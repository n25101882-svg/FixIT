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
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000/api/v1"
).replace(/\/$/, "");

export async function api<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl + path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "Не вдалося з’єднатися з FixIT. Перевірте мережу та спробуйте ще раз.",
    );
  }
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
