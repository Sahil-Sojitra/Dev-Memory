import { memorySearch } from "./fixtures/search-knowledge.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { memoryCaptureWriter } from "./fixtures/capture-knowledge.ts";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { createProjectContextService } from "../src/services/project-context.ts";
import { createProjectListingService } from "../src/services/projects.ts";
import { createLogger } from "../src/observability/logger.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { KnowledgeEntryService } from "../src/domain/knowledge-entry.ts";
import { memoryConnection } from "./fixtures/mcp.ts";
import { memoryKnowledgeRepository, detail, bodyBlock } from "./fixtures/knowledge-entry.ts";
import { memoryContextRepository } from "./fixtures/project-context.ts";
import { inMemoryProjects } from "./fixtures/projects.ts";

async function connect(service: KnowledgeEntryService = createKnowledgeEntryService(memoryKnowledgeRepository())) {
  const logs: string[] = [];
  const connection = await memoryConnection(createMcpServer({ search: memorySearch().service,
    projects: createProjectListingService(inMemoryProjects()), projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: service,
    capture: createCaptureService(memoryCaptureWriter().writer, memoryContextRepository()), logger: createLogger({ environment: {}, destination: { write(line: string) { logs.push(line); } } }),
  }));
  await connection.initialize();
  return { connection, logs };
}
describe("get_knowledge_entry MCP contract", () => {
  it("advertises required pageId, bounded output and read-only annotations", async () => {
    const { connection } = await connect();
    try {
      const tools = await connection.request("tools/list");
      expect(tools.result?.tools?.find((tool) => tool.name === "get_knowledge_entry")).toMatchObject({
        inputSchema: { required: ["pageId"], additionalProperties: false }, outputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
    } finally { await connection.close(); }
  });
  it("returns metadata, Markdown and text/structured parity without logging content", async () => {
    const service = createKnowledgeEntryService(memoryKnowledgeRepository([bodyBlock(1, "paragraph", "private-body-sentinel")]));
    const { connection, logs } = await connect(service);
    try {
      const reply = await connection.request("tools/call", { name: "get_knowledge_entry", arguments: { pageId: detail.id } });
      expect(reply.result?.isError).not.toBe(true);
      expect(reply.result?.structuredContent).toMatchObject({ entry: detail, content: { markdown: "private-body-sentinel", truncated: false }, truncated: false });
      expect(JSON.parse(reply.result?.content?.[0]?.text ?? "{}")).toEqual(reply.result?.structuredContent);
      expect(logs.join("")).not.toContain("private-body-sentinel");
      expect(logs.join("")).not.toContain(detail.id);
    } finally { await connection.close(); }
  });
  it.each([{}, { pageId: "private-invalid-uuid" }, { pageId: detail.id, privateUnknownKey: "private-input-value" }])("rejects invalid input without echoing it", async (input) => {
    const { connection } = await connect();
    try {
      const reply = await connection.request("tools/call", { name: "get_knowledge_entry", arguments: input });
      expect(reply.result?.isError).toBe(true);
      expect(JSON.stringify(reply)).not.toMatch(/private-invalid-uuid|privateUnknownKey|private-input-value/);
    } finally { await connection.close(); }
  });
  it.each(["NOT_FOUND", "NOT_IN_KNOWLEDGE_DB"] as const)("maps %s through existing safe errors", async (code) => {
    const { connection } = await connect({ get: async () => { throw new DomainError(code); } });
    try {
      const reply = await connection.request("tools/call", { name: "get_knowledge_entry", arguments: { pageId: detail.id } });
      expect(reply.result).toMatchObject({ isError: true, structuredContent: { error: { code, retryable: false, correlationId: expect.any(String) } } });
    } finally { await connection.close(); }
  });
  it("reports unsupported partial content as a successful but explicitly truncated result", async () => {
    const { connection } = await connect(createKnowledgeEntryService(memoryKnowledgeRepository([bodyBlock(1, "future_block")])));
    try {
      const reply = await connection.request("tools/call", { name: "get_knowledge_entry", arguments: { pageId: detail.id } });
      expect(reply.result?.isError).not.toBe(true);
      expect(reply.result?.structuredContent).toMatchObject({ truncated: true, content: { truncated: true, reasons: ["unsupported_block"] } });
    } finally { await connection.close(); }
  });
});
