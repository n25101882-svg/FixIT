import { safeStandardReturn } from "./standard-return";

/** Only known protected order pages may survive a new in-memory session. */
export function safeOrderReturn(value: unknown): string | null {
  const standard = safeStandardReturn(value);
  if (standard) return standard;
  if (typeof value !== "string") return null;
  const match = /^\/(orders|master\/orders)\/([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/.exec(value);
  return match && match[0] === value ? `/${match[1]}/${match[2]!.toLowerCase()}` : null;
}
