import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

export const sessionAbsoluteMs = 7 * 24 * 60 * 60 * 1000;
export const sessionIdleMs = 24 * 60 * 60 * 1000;
export const concurrentRefreshMs = 2000;
export const sessionUserSelect = { id: true, email: true, name: true, role: true } as const;
export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createSessionService(database: PrismaClient, secret: string, clock = () => new Date()) {
  // Domain-separated issuance MAC authenticates old generations without retaining
  // plaintext or an unbounded list of retired hashes. It never replaces DB checks.
  const key = createHmac("sha256", secret).update("fixit.refresh.issuance.v1").digest();
  const mac = (value: string) => createHmac("sha256", key).update(value).digest("base64url");
  function parse(token: string | undefined) {
    const match = token?.match(/^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(0|[1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
    if (!match || !equal(mac(token!.slice(0, token!.lastIndexOf("."))), match[4]!)) return null;
    return { id: match[1]!, generation: Number(match[2]), hash: sessionHash(token!) };
  }
  function issue(id: string, generation: number) {
    const value = `v1.${id}.${generation}.${randomBytes(32).toString("base64url")}`;
    return `${value}.${mac(value)}`;
  }
  return {
    identify: (token: string | undefined) => parse(token)?.id,
    async create(userId: string, previous?: string) {
      const now = clock(), expiresAt = new Date(now.getTime() + sessionAbsoluteMs);
      const id = randomUUID(), token = issue(id, 0), old = parse(previous);
      await database.$transaction(async (tx) => {
        if (old) await tx.authSession.updateMany({ where: { id: old.id, revokedAt: null, generation: { gte: old.generation } }, data: { revokedAt: now, revokedReason: "logout" } });
        await tx.authSession.create({ data: { id, userId, tokenHash: sessionHash(token), createdAt: now, lastUsedAt: now, expiresAt } });
      });
      return { token, expiresAt };
    },
    async rotate(token: string | undefined) {
      const presented = parse(token);
      if (!presented) return { kind: "denied" } as const;
      return database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id=${presented.id}::uuid FOR UPDATE`;
        const row = await tx.authSession.findUnique({ where: { id: presented.id }, include: { user: { select: sessionUserSelect } } });
        if (!row || row.revokedAt) return { kind: "denied" } as const;
        const now = clock();
        if (now >= row.expiresAt || now.getTime() - row.lastUsedAt.getTime() >= sessionIdleMs) {
          await tx.authSession.update({ where: { id: row.id }, data: { revokedAt: now, revokedReason: "expired" } });
          return { kind: "denied" } as const;
        }
        if (presented.generation < row.generation) {
          if ((presented.generation < row.generation - 1 || (row.previousTokenHash && equal(presented.hash, row.previousTokenHash)))
            && row.rotatedAt && now.getTime() - row.rotatedAt.getTime() <= concurrentRefreshMs)
            return { kind: "conflict" } as const;
          await tx.authSession.update({ where: { id: row.id }, data: { revokedAt: now, revokedReason: "replay" } });
          return { kind: "denied" } as const;
        }
        if (presented.generation !== row.generation || !equal(presented.hash, row.tokenHash)) return { kind: "denied" } as const;
        const next = issue(row.id, row.generation + 1);
        await tx.authSession.update({ where: { id: row.id }, data: { tokenHash: sessionHash(next), previousTokenHash: row.tokenHash,
          generation: row.generation + 1, rotatedAt: now, lastUsedAt: now } });
        return { kind: "ok", token: next, expiresAt: row.expiresAt, user: row.user } as const;
      });
    },
    async revoke(token: string | undefined) {
      const presented = parse(token);
      if (presented) await database.authSession.updateMany({ where: { id: presented.id, generation: { gte: presented.generation }, revokedAt: null },
        data: { revokedAt: clock(), revokedReason: "logout" } });
    },
  };
}
