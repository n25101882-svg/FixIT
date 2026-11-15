import { createHash } from "node:crypto";
import type { MasterProfile, Service } from "../generated/prisma/client.js";

/** Optimistic preview check, not an identity/authorization token. The command
 * recomputes it from locked authoritative rows before copying the snapshot. */
export function standardSnapshot(service: Pick<Service, "id" | "title" | "category" | "priceEstimate" | "masterProfileId"> & { masterProfile: Pick<MasterProfile, "id" | "city"> }) {
  return createHash("sha256").update(JSON.stringify([
    service.id, service.masterProfileId, service.title, service.category,
    service.masterProfile.city, service.priceEstimate?.toFixed(2) ?? null,
  ])).digest("hex");
}
