import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/environment.ts";
import { ConfigurationError } from "../src/domain/errors.ts";
import { FAKE_BEARER_SHA256, FAKE_NOTION_TOKEN, validEnvironment } from "./fixtures/environment.ts";

describe("environment validation", () => {
  it("defaults to stdio without remote credentials and does not mutate input", () => {
    const input = Object.freeze({ ...validEnvironment });
    const config = loadConfig(input);
    expect(config.transport).toBe("stdio");
    expect(config.logLevel).toBe("info");
    expect(config.notion.apiVersion).toBe("2025-09-03");
    expect(config.notion.apiToken).toBe(FAKE_NOTION_TOKEN);
    expect(config).not.toHaveProperty("http");
    expect(input).not.toHaveProperty("MCP_TRANSPORT");
    expect(Object.isFrozen(config.notion.dataSources)).toBe(true);
  });

  it("ignores unrelated HTTP settings for the local transport", () => {
    expect(loadConfig({ ...validEnvironment, MCP_TRANSPORT: "stdio", MCP_PUBLIC_URL: "invalid", MCP_BEARER_TOKEN: "" }).transport).toBe("stdio");
  });

  it("validates remote configuration, derives hosts and deduplicates HTTPS origins", () => {
    const config = loadConfig({
      ...validEnvironment, MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256,
      MCP_PUBLIC_URL: "https://memory.example.test/mcp",
      MCP_ALLOWED_ORIGINS: "https://client.example.test, https://client.example.test/",
    });
    expect(config.transport).toBe("http");
    if (config.transport !== "http") throw new Error("Expected HTTP configuration");
    expect(config.http.bearerTokenSha256).toBe(FAKE_BEARER_SHA256);
    expect(config.http.allowedHosts).toEqual(["memory.example.test"]);
    expect(config.http.allowedOrigins).toEqual(["https://client.example.test"]);
  });

  it("does not require browser origins for non-browser remote clients", () => {
    const config = loadConfig({ ...validEnvironment, MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256, MCP_PUBLIC_URL: "https://memory.example.test/mcp" });
    expect(config.transport === "http" && config.http.allowedOrigins).toEqual([]);
  });

  it.each([
    ["missing Notion token", { NOTION_API: undefined }],
    ["blank Notion token", { NOTION_API: "" }],
    ["whitespace token", { NOTION_API: "unsafe token" }],
    ["unknown transport", { MCP_TRANSPORT: "sse" }],
    ["empty transport", { MCP_TRANSPORT: "" }],
    ["bad database ID", { NOTION_PROJECTS_DATABASE_ID: "invalid-id" }],
    ["duplicate IDs", { NOTION_SUBPROJECTS_DATABASE_ID: validEnvironment.NOTION_PROJECTS_DATABASE_ID }],
    ["invalid optional data source assertion", { NOTION_PROJECTS_DATA_SOURCE_ID: "invalid-id" }],
    ["wrong API version", { NOTION_API_VERSION: "2026-03-11" }],
    ["bad log level", { LOG_LEVEL: "verbose" }],
    ["bad node environment", { NODE_ENV: "staging" }],
    ["missing HTTP credentials", { MCP_TRANSPORT: "http" }],
    ["legacy plaintext bearer", { MCP_TRANSPORT: "http", MCP_BEARER_TOKEN: "short", MCP_PUBLIC_URL: "https://memory.example.test/mcp" }],
    ["reused Notion token", { MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: createHash("sha256").update(FAKE_NOTION_TOKEN).digest("hex"), MCP_PUBLIC_URL: "https://memory.example.test/mcp" }],
    ["insecure HTTP URL", { MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256, MCP_PUBLIC_URL: "http://memory.example.test/mcp" }],
    ["URL credentials", { MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256, MCP_PUBLIC_URL: "https://user:password@memory.example.test/mcp" }],
    ["origin path", { MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256, MCP_PUBLIC_URL: "https://memory.example.test/mcp", MCP_ALLOWED_ORIGINS: "https://client.example.test/path" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => loadConfig({ ...validEnvironment, ...overrides })).toThrow(ConfigurationError);
  });

  it("reports only field names, never invalid input values or Zod input", () => {
    const secret = "a-sensitive-invalid-value";
    try {
      loadConfig({ ...validEnvironment, LOG_LEVEL: secret });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(FAKE_NOTION_TOKEN);
      expect((error as ConfigurationError).invalidFields).toContain("LOG_LEVEL");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
