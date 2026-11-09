import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/observability/logger.ts";
import { createCorrelationId, getCorrelationId, withCorrelationId } from "../src/observability/context.ts";
import { ConfigurationError, DomainError } from "../src/domain/errors.ts";
import { FAKE_BEARER_TOKEN, FAKE_NOTION_TOKEN } from "./fixtures/environment.ts";

function capture(environment: Readonly<Record<string, string | undefined>> = {}, secrets: readonly string[] = []) {
  const lines: string[] = [];
  const logger = createLogger({
    level: "trace", environment, secrets,
    destination: { write(line: string) { lines.push(line); } },
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("structured logging and redaction", () => {
  it("redacts sensitive keys at every object depth and in child bindings", () => {
    const { logger, lines } = capture();
    logger.child({ Authorization: "child-sensitive", subsystem: "fixture" }).info("structured_event", {
      notion_api: "notion-sensitive",
      nested: [{ apiKey: "key-sensitive", password: "password-sensitive" }],
      headers: { authorization: "Bearer header-sensitive", "x-api-key": "header-key-sensitive" },
      config: { hidden: "configuration-sensitive" },
      env: { unrelated: "environment-sensitive" },
      bearerToken: "bearer-sensitive",
    });
    const output = lines.join("");
    for (const value of ["child-sensitive", "notion-sensitive", "key-sensitive", "password-sensitive", "header-sensitive", "header-key-sensitive", "configuration-sensitive", "environment-sensitive", "bearer-sensitive"]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("structured_event");
    expect(output).toContain("fixture");
  });

  it("redacts known environment secrets in messages, arbitrary fields, keys and child bindings", () => {
    const environment = {
      NOTION_API: FAKE_NOTION_TOKEN, MCP_BEARER_TOKEN: FAKE_BEARER_TOKEN,
      CUSTOM_API_KEY: "synthetic/key+with?encoding",
      SOME_SECRET: "unprefixed-sensitive-value",
    };
    const { logger, lines } = capture(environment);
    logger.child({ note: environment.SOME_SECRET }).warn("event " + environment.SOME_SECRET, {
      note: FAKE_NOTION_TOKEN, other: FAKE_BEARER_TOKEN,
      url: encodeURIComponent(environment.CUSTOM_API_KEY),
      [environment.SOME_SECRET]: "field name",
    });
    const output = lines.join("");
    for (const secret of Object.values(environment)) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(encodeURIComponent(secret));
    }
  });

  it("redacts unknown credential shapes and assignments in free text", () => {
    const { logger, lines } = capture();
    logger.info("Authorization: Bearer unknown-sensitive-value", {
      a: "api_key=other-sensitive-value",
      b: "ntn_unknown_sensitive_value",
      c: "secret_unknown_sensitive_value",
      d: "Basic c3ludGhldGljOnNlY3JldA==",
    });
    const output = lines.join("");
    for (const secret of ["unknown-sensitive-value", "other-sensitive-value", "ntn_unknown_sensitive_value", "secret_unknown_sensitive_value", "c3ludGhldGljOnNlY3JldA=="]) expect(output).not.toContain(secret);
  });

  it("omits raw error messages, stack traces and nested causes", () => {
    const { logger, lines } = capture();
    const cause = new Error("sensitive vendor payload");
    logger.error("failure", {
      err: new Error("sensitive raw message", { cause }),
      domain: new DomainError("DEPENDENCY_UNAVAILABLE", { cause }),
      configuration: new ConfigurationError(["NOTION_API"]),
    });
    const output = lines.join("");
    expect(output).not.toContain("sensitive");
    expect(output).not.toContain("stack");
    expect(output).toContain("DEPENDENCY_UNAVAILABLE");
  });

  it("handles cycles, binary data, deeply nested objects and accessors without executing them", () => {
    const { logger, lines } = capture();
    const getter = vi.fn(() => "sensitive getter");
    const object: Record<string, unknown> = { buffer: Buffer.from("sensitive bytes") };
    object.self = object;
    Object.defineProperty(object, "getter", { enumerable: true, get: getter });
    logger.info("safe_serialization", object);
    expect(getter).not.toHaveBeenCalled();
    expect(lines.join("")).toContain("[Circular]");
    expect(lines.join("")).toContain("[Binary]");
    expect(lines.join("")).not.toContain("sensitive");
  });

  it("applies redaction at all log levels and honors silent mode", () => {
    const { logger, lines } = capture({}, ["synthetic-level-secret"]);
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      logger[level]("synthetic-level-secret", { arbitrary: "synthetic-level-secret" });
    }
    expect(lines).toHaveLength(6);
    expect(lines.join("")).not.toContain("synthetic-level-secret");
    const silent = createLogger({ level: "silent", environment: {}, destination: { write(line: string) { lines.push(line); } } });
    silent.fatal("should_not_appear");
    expect(lines).toHaveLength(6);
  });

  it("redacts a known secret even when supplied as a valid correlation ID", () => {
    const secretId = "66666666-6666-4666-8666-666666666666";
    const { logger, lines } = capture({ MCP_BEARER_TOKEN: secretId });
    withCorrelationId(() => logger.info("correlation_redaction"), secretId);
    expect(lines.join("")).not.toContain(secretId);
    expect(lines.join("")).toContain("[REDACTED]");
  });

  it("handles malformed Unicode secrets and cannot invoke child-binding methods", () => {
    const malformed = "synthetic-secret-\ud800";
    const { logger, lines } = capture({}, [malformed]);
    logger.child({ hasOwnProperty: "not-a-function", note: malformed }).info("safe_child", { note: malformed });
    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain("synthetic-secret-");
  });

  it("defaults to stderr and never writes diagnostics to stdout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    createLogger({ environment: {} }).info("stderr_only_fixture");
    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ msg: "stderr_only_fixture", service: "devmemory" });
  });
});

describe("correlation context", () => {
  it("validates incoming IDs and generates IDs for invalid values", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(createCorrelationId(id)).toBe(id);
    expect(createCorrelationId("untrusted-id\nwith-lines")).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCorrelationId()).toBeUndefined();
  });

  it("keeps concurrent async scopes separate, including child loggers", async () => {
    const { logger, records } = capture();
    const child = logger.child({ component: "fixture" });
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    await Promise.all([
      withCorrelationId(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); child.info("first", { correlationId: "spoofed" }); }, first),
      withCorrelationId(async () => { await Promise.resolve(); child.info("second"); }, second),
    ]);
    expect(records().find((record) => record.msg === "first")?.correlationId).toBe(first);
    expect(records().find((record) => record.msg === "second")?.correlationId).toBe(second);
    expect(getCorrelationId()).toBeUndefined();
  });
});
