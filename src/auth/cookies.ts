import type { CookieOptions, Request, Response } from "express";
import { HttpError } from "../http-error.js";

export function sessionCookies(secure = process.env.NODE_ENV === "production") {
  if (process.env.NODE_ENV === "production" && !secure) throw new Error("Production refresh cookies must be Secure.");
  const name = secure ? "__Host-fixit_refresh" : "fixit_refresh_dev";
  const attributes: CookieOptions = { httpOnly: true, secure, sameSite: "lax", path: "/" };
  return {
    name,
    guard(request: Request) {
      let host: string;
      try { host = new URL(`http://${request.get("host")}`).hostname; } catch { host = ""; }
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(host)
        && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
      if (secure) {
        if (!request.secure && !local) throw new HttpError(403, "COOKIE_TRANSPORT", "Для production-сесії потрібен HTTPS.");
        return;
      }
      if (!local)
        throw new HttpError(403, "COOKIE_TRANSPORT", "Локальна cookie доступна лише через loopback.");
    },
    read(request: Request) {
      const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(name + "="));
      return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
    },
    set(response: Response, token: string, expiresAt: Date) {
      response.cookie(name, token, { ...attributes, expires: expiresAt, maxAge: Math.max(0, expiresAt.getTime() - Date.now()) });
    },
    clear(response: Response) { response.clearCookie(name, attributes); },
  };
}
