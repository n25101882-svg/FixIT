const prefix = "/orders/new/standard/";
export function safeStandardReturn(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id.length === 36 && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? prefix + id.toLowerCase() : null;
}
export function standardAuthPath(path: "/login" | "/register", returnTo: string | null): string {
  return returnTo ? `${path}?${new URLSearchParams({ returnTo })}` : path;
}
