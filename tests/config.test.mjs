import { describe, expect, test } from "@jest/globals";
import { requireDatabaseUrl, requireLocalTestDatabase } from "../dist/config.js";

describe("database configuration safety", () => {
  test("accepts an explicit local test database", () => {
    expect(requireLocalTestDatabase("postgresql://test:unused@127.0.0.1:55432/fixit_test?schema=public")).toContain("/fixit_test");
  });

  test.each([
    undefined,
    "postgresql://test:unused@db.example.com/fixit_test",
    "postgresql://test:unused@127.0.0.1/fixit_production",
    "postgresql://test:unused@127.0.0.1/fixit_test?host=db.example.com",
    "postgresql://test:unused@127.0.0.1/fixit_test?hostaddr=192.0.2.1",
    "postgresql://test:unused@127.0.0.1/fixit_test?service=production",
  ])("refuses absent/nonlocal/non-test/overridden test endpoints (%#)", (value) => {
    expect(() => requireLocalTestDatabase(value)).toThrow();
  });

  test("invalid URL errors do not reveal credentials", () => {
    expect(() => requireDatabaseUrl("invalid-secret-value")).toThrow("value hidden");
    expect(() => requireDatabaseUrl("invalid-secret-value")).not.toThrow("invalid-secret-value");
  });
});
