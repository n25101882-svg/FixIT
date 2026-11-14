import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N, r, p, maxmem: parameters.maxmem },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(
    password,
    salt,
    parameters.N,
    parameters.r,
    parameters.p,
  );
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function dummyPasswordHash(): string {
  // A valid-cost comparison for unknown accounts, without a shared password.
  return `scrypt$32768$8$3$${randomBytes(16).toString("base64url")}$${randomBytes(64).toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Support the existing Practical #6 seed format as well as new auth hashes.
  if (
    !(
      (N === 16384 && r === 8 && p === 1) ||
      (N === 32768 && r === 8 && p === 3)
    )
  )
    return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await derive(password, salt, N, r, p);
  return timingSafeEqual(expected, actual);
}
