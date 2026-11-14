import { memorySearch } from "./fixtures/search-knowledge.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { memoryCaptureWriter } from "./fixtures/capture-knowledge.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { memoryKnowledgeRepository } from "./fixtures/knowledge-entry.ts";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { memoryContextRepository } from "./fixtures/project-context.ts";
import { createProjectContextService } from "../src/services/project-context.ts";
import { DomainError } from "../src/domain/errors.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createProjectListingService } from "../src/services/projects.ts";
import { inMemoryProjects, project } from "./fixtures/projects.ts";
import { memoryConnection } from "./fixtures/mcp.ts";

function logger() { return createLogger({ environment: {}, destination: { write() { /* No diagnostic output in contract tests. */ } } }); }

describe("shared MCP factory contract", () => {
  it("advertises and invokes project context with independent per-call budgets", async () => {
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      await connection.initialize();
      const listing = await connection.request("tools/list");
      expect(listing.result?.tools?.find((tool) => tool.name === "get_project_context")).toMatchObject({
        inputSchema: { required: ["projectId"], properties: { recentLimit: { minimum: 1, maximum: 25, default: 10 } } }, outputSchema: { type: "object" },
      });
      for (let index = 0; index < 2; index++) {
        const reply = await connection.request("tools/call", { name: "get_project_context", arguments: { projectId: project.id, recentLimit: 1 } });
        expect(reply.result?.isError).not.toBe(true);
        expect(reply.result?.structuredContent).toMatchObject({ project, knowledgeCounts: { total: 1 }, requestBudget: { usedRequests: 6 } });
        expect(JSON.parse(reply.result?.content?.[0]?.text ?? "{}")).toEqual(reply.result?.structuredContent);
      }
    } finally { await connection.close(); }
  });
  it.each([{ projectId: "private-invalid-id" }, { projectId: project.id, recentLimit: 26 }, { projectId: project.id, privateCallerKey: "private-value" }])("rejects invalid project context arguments without echoing input", async (input) => {
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "get_project_context", arguments: input });
      expect(reply.result?.isError).toBe(true);
      expect(JSON.stringify(reply)).not.toMatch(/private-invalid-id|privateCallerKey|private-value/);
    } finally { await connection.close(); }
  });
  it("maps relation failures through the context adapter without leaking raw errors", async () => {
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: { get: async () => { throw new DomainError("INVALID_RELATION"); } }, knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "get_project_context", arguments: { projectId: project.id } });
      expect(reply.result).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_RELATION", correlationId: expect.any(String) } } });
    } finally { await connection.close(); }
  });
  it("discovers exactly five tools with input/output schemas and static registry", async () => {
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      expect((await connection.initialize()).result).toMatchObject({ serverInfo: { name: "devmemory" }, capabilities: { tools: { listChanged: false } } });
      const listed = await connection.request("tools/list");
      expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["list_projects", "get_project_context", "get_knowledge_entry", "capture_knowledge", "search_knowledge"]);
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
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
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
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "list_projects", arguments: input });
      expect(reply.result?.isError).toBe(true);
      expect(reply.result?.content?.[0]?.text).toContain("Active, Paused, Archived");
      expect(JSON.stringify(reply)).not.toMatch(/unexpectedSyntheticSecretKey|synthetic-secret-value/);
    } finally { await connection.close(); }
  });
  it.each([new DomainError("RATE_LIMITED"), new Error("synthetic-secret-value and private stack")])("maps service failures without stack or secret leakage", async (failure) => {
    const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: { list: async () => { throw failure; } }, projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() }));
    try {
      await connection.initialize();
      const reply = await connection.request("tools/call", { name: "list_projects" });
      expect(reply.result).toMatchObject({ isError: true, structuredContent: { error: { code: failure instanceof DomainError ? "RATE_LIMITED" : "INTERNAL_ERROR", correlationId: expect.any(String) } } });
      expect(JSON.stringify(reply)).not.toMatch(/synthetic-secret-value|private stack|"stack"/);
    } finally { await connection.close(); }
  });
  it("supports independent factory instances without duplicate tool registrations", async () => {
    const services = { search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()), capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: logger() };
    for (let i = 0; i < 2; i++) {
      const connection = await memoryConnection(createMcpServer(services));
      try { await connection.initialize(); expect((await connection.request("tools/list")).result?.tools).toHaveLength(5); }
      finally { await connection.close(); }
    }
  });
});
