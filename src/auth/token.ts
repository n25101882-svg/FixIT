import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { randomUUID } from "node:crypto";

export const tokenIssuer = "fixit-api";
export const tokenAudience = "fixit-web";

export interface TokenOptions {
  jwtSecret: string;
  tokenTtlSeconds: number;
}

export function issueToken(userId: string, options: TokenOptions): string {
  return jwt.sign({}, options.jwtSecret, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: options.tokenTtlSeconds,
    issuer: tokenIssuer,
    audience: tokenAudience,
    jwtid: randomUUID(),
  });
}

export function authenticate(options: TokenOptions): RequestHandler {
  return (request, response, next) => {
    const unauthorized = () =>
      next(
        new HttpError(401, "UNAUTHORIZED", "Увійдіть у свій обліковий запис."),
      );
    const match = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9._-]+)$/i,
    );
    if (!match?.[1]) return unauthorized();
    try {
      const payload = jwt.verify(match[1], options.jwtSecret, {
        algorithms: ["HS256"],
        issuer: tokenIssuer,
        audience: tokenAudience,
      });
      if (
        typeof payload === "string" ||
        typeof payload.exp !== "number" ||
        !z.uuid().safeParse(payload.sub).success
      ) {
        return unauthorized();
      }
      response.locals.userId = payload.sub;
      next();
    } catch {
      unauthorized();
    }
  };
}
