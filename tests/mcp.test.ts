import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createProjectListingService } from "../src/services/projects.ts";
import { inMemoryProjects, project } from "./fixtures/projects.ts";
import { memoryConnection } from "./fixtures/mcp.ts";

function logger() { return createLogger({ environment: {}, destination: { write() { /* No diagnostic output in contract tests. */ } } }); }

describe("shared MCP factory contract", () => {
  it("discovers exactly one tool with input/output schemas and static registry", async () => {
    const connection = await memoryConnection(createMcpServer({ projects: createProjectListingService(inMemoryProjects()), logger: logger() }));
    try {
      expect((await connection.initialize()).result).toMatchObject({ serverInfo: { name: "devmemory" }, capabilities: { tools: { listChanged: false } } });
      const listed = await connection.request("tools/list");
      expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["list_projects"]);
      expect(listed.result?.tools?.[0]).toMatchObject({ inputSchema: { type: "object", properties: { limit: { minimum: 1, maximum: 100, default: 50 }, status: { enum: ["Active", "Paused", "Archived"] } } }, outputSchema: { type: "object" } });
      // Antigravity 1.5.3 rejects JSON Schema patterns containing JS-only \u
      // escapes. The wire schema must retain the equivalent portable hex form.
      const properties = listed.result?.tools?.[0]?.inputSchema.properties as Record<string, { pattern?: string }>;
      const pattern = properties.cursor?.pattern;
      expect(pattern).toBe("^[^\\x00-\\x1f\\x7f]+$");
      const cursorPattern = new RegExp(pattern!);
      for (let code = 0; code < 32; code++) expect(cursorPattern.test("cursor" + String.fromCharCode(code))).toBe(false);
      expect(cursorPattern.test("cursor\x7f")).toBe(false);
      expect(cursorPattern.test("opaque:ABC-123_é")).toBe(true);
    } finally { await connection.close(); }
  });
  it("calls the application service and returns consistent structured/text output", async () => {
    const connection = await memoryConnection(createMcpServer({ projects: createProjectListingService(inMemoryProjects()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "list_projects", arguments: { nameContains: "dEv", status: "Active", limit: 1 } });
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError).not.toBe(true);
      expect(reply.result?.structuredContent).toEqual({ projects: [project], hasMore: false, nextCursor: null });
      expect(JSON.parse(reply.result?.content?.[0]?.text ?? "{}")).toEqual(reply.result?.structuredContent);
      expect(JSON.stringify(reply)).not.toMatch(/created_by|annotations|properties|data_source_id/);
    } finally { await connection.close(); }
  });
  it.each([{ limit: 0 }, { status: "active" }, { unexpectedSyntheticSecretKey: "synthetic-secret-value" }, { nameContains: "" }, { cursor: "" }])("rejects invalid input safely: %j", async (input) => {
    const connection = await memoryConnection(createMcpServer({ projects: createProjectListingService(inMemoryProjects()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "list_projects", arguments: input });
      expect(reply.result?.isError).toBe(true);
      expect(reply.result?.content?.[0]?.text).toContain("Active, Paused, Archived");
      expect(JSON.stringify(reply)).not.toMatch(/unexpectedSyntheticSecretKey|synthetic-secret-value/);
    } finally { await connection.close(); }
  });
  it.each([new DomainError("RATE_LIMITED"), new Error("synthetic-secret-value and private stack")])("maps service failures without stack or secret leakage", async (failure) => {
    const connection = await memoryConnection(createMcpServer({ projects: { list: async () => { throw failure; } }, logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "list_projects" });
      expect(reply.result).toMatchObject({ isError: true, structuredContent: { error: { code: failure instanceof DomainError ? "RATE_LIMITED" : "INTERNAL_ERROR", correlationId: expect.any(String) } } });
      expect(JSON.stringify(reply)).not.toMatch(/synthetic-secret-value|private stack|"stack"/);
    } finally { await connection.close(); }
  });
  it("supports independent factory instances without duplicate tool registrations", async () => {
    const services = { projects: createProjectListingService(inMemoryProjects()), logger: logger() };
    for (let i = 0; i < 2; i++) {
      const connection = await memoryConnection(createMcpServer(services));
      try { await connection.initialize(); expect((await connection.request("tools/list")).result?.tools).toHaveLength(1); }
      finally { await connection.close(); }
    }
  });
});
