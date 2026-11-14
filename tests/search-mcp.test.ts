import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createProjectListingService } from "../src/services/projects.ts";
import { createProjectContextService } from "../src/services/project-context.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { memorySearch } from "./fixtures/search-knowledge.ts";
import { memoryConnection } from "./fixtures/mcp.ts";
import { inMemoryProjects } from "./fixtures/projects.ts";
import { memoryCaptureWriter } from "./fixtures/capture-knowledge.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { SearchService } from "../src/domain/search-knowledge.ts";

async function connect(search?: SearchService) {
  const f = memorySearch(), logs: string[] = [];
  const connection = await memoryConnection(createMcpServer({ search: search ?? f.service, projects: createProjectListingService(inMemoryProjects()),
    projectContext: createProjectContextService(f.scope), knowledgeEntry: f.bodies, capture: createCaptureService(memoryCaptureWriter().writer, f.scope),
    logger: createLogger({ environment: {}, destination: { write(line: string) { logs.push(line); } } }),
  })); await connection.initialize(); return { connection, logs, f };
}
describe("search_knowledge shared MCP adapter", () => {
  it("discovers five tools, advertises read-only search, validates output and agrees across text/structured responses", async () => {
    const { connection, logs } = await connect();
    try {
      const tools = (await connection.request("tools/list")).result!.tools!; expect(tools).toHaveLength(5);
      expect(tools.find((tool) => tool.name === "search_knowledge")).toMatchObject({ annotations: { readOnlyHint: true, idempotentHint: true }, inputSchema: { required: ["query"] }, outputSchema: { type: "object" } });
      const result = await connection.request("tools/call", { name: "search_knowledge", arguments: { query: "deploy node", limit: 1 } });
      expect(result.result?.isError).not.toBe(true); expect(result.result?.structuredContent).toEqual(JSON.parse(result.result!.content![0]!.text));
      expect(result.result?.structuredContent).toMatchObject({ results: [{ title: "Deploy node" }], diagnostics: { bodiesScanned: 10, maxRequests: 40, truncated: true } });
      expect(logs.join("")).not.toContain("deploy node"); expect(logs.join("")).not.toContain("Deploy node");
    } finally { await connection.close(); }
  });
  it.each([{ query: " " }, { query: "secret-query", type: ["invented"] }, { query: "secret-query", limit: 26 }])("rejects invalid input safely before I/O", async (input) => {
    const { connection, logs, f } = await connect();
    try { const result = await connection.request("tools/call", { name: "search_knowledge", arguments: input }); expect(result.error ?? result.result?.isError).toBeTruthy(); expect(f.calls.candidates).toBe(0); expect(JSON.stringify(result) + logs.join("")).not.toContain("secret-query"); }
    finally { await connection.close(); }
  });
  it("maps safe dependency errors without leaking raw vendor data", async () => {
    const { connection, logs } = await connect({ async search() { throw new DomainError("UNAUTHORIZED"); }, invalidate() {} });
    try { const result = await connection.request("tools/call", { name: "search_knowledge", arguments: { query: "private-query" } }); expect(result.result).toMatchObject({ isError: true, structuredContent: { error: { code: "UNAUTHORIZED" } } }); expect(logs.join("")).not.toContain("private-query"); }
    finally { await connection.close(); }
  });
});
