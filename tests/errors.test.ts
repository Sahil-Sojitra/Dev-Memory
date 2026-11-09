import { describe, expect, it } from "vitest";
import { ConfigurationError, DomainError, ERROR_CATALOG, mapError } from "../src/domain/errors.ts";
import type { ErrorCode } from "../src/domain/errors.ts";

describe("safe domain error mapping", () => {
  it.each(Object.keys(ERROR_CATALOG) as ErrorCode[])("maps %s using its stable catalog definition", (code) => {
    const cause = new Error("vendor response containing a secret");
    const mapped = mapError(new DomainError(code, { cause }), "correlation-fixture");
    expect(mapped).toEqual({ code, ...ERROR_CATALOG[code], correlationId: "correlation-fixture" });
    expect(Object.isFrozen(mapped)).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain(cause.message);
    expect(mapped).not.toHaveProperty("stack");
    expect(mapped).not.toHaveProperty("cause");
  });

  it.each([new Error("Authorization: Bearer synthetic-sensitive-token"), "sensitive thrown string", null, { code: "NOT_FOUND", message: "spoofed secret" }])("hides unknown thrown values", (error) => {
    expect(mapError(error, "test-correlation")).toEqual({
      code: "INTERNAL_ERROR", message: "An unexpected error occurred.",
      httpStatus: 500, retryable: false, correlationId: "test-correlation",
    });
  });

  it("does not expose configuration fields in public errors", () => {
    expect(mapError(new ConfigurationError(["NOTION_API"]), "test-correlation")).not.toHaveProperty("invalidFields");
  });
});
