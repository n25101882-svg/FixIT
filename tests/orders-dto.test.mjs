import { expect, test } from "@jest/globals";
import { masterOrder, publicOrder } from "../dist/orders/dto.js";

const at = "2026-11-15T15:07:32.123456+00:00";
const order = { id: "synthetic-order", type: "CUSTOM", status: "COMPLETED", title: "Synthetic", description: "Synthetic",
  city: "Synthetic city", category: "OTHER", budget: null, priceAtOrder: null, createdAt: new Date("2026-11-01T00:00:00Z"), updatedAt: new Date(),
  statusHistory: [{ status: "COMPLETED", at, source: "database", actorUserId: "private-synthetic-user" }] };
test("completion timestamp is derived from the genuine database completion event in both DTOs", () => {
  expect(masterOrder(order).completedAt).toBe("2026-11-15T15:07:32.123Z");
  expect(publicOrder(order).completedAt).toBe(masterOrder(order).completedAt);
  expect(masterOrder(order)).not.toHaveProperty("statusHistory");
  expect(JSON.stringify(masterOrder(order))).not.toContain("private-synthetic-user");
});
test.each([
  [], [{ status: "COMPLETED", at, source: "legacy_migration" }], [{ status: "COMPLETED", at: "not-a-date", source: "database" }],
  [{ status: "IN_PROGRESS", at, source: "database" }], [null, [], "text", { status: "COMPLETED", source: "database" }], null,
])("legacy/missing/malformed history %# never invents a completion date", (history) => {
  const row = { ...order, statusHistory: history };
  expect(masterOrder(row).completedAt).toBeNull(); expect(publicOrder(row).completedAt).toBeNull();
});
test.each(["ACCEPTED", "IN_PROGRESS", "CANCELLED", "DECLINED"])("%s has no completion timestamp", (status) => {
  expect(masterOrder({ ...order, status }).completedAt).toBeNull();
});
