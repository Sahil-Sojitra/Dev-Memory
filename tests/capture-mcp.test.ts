import { memorySearch } from "./fixtures/search-knowledge.ts";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import type { CaptureService } from "../src/domain/capture-knowledge.ts";
import { PartialWriteError, WriteConfirmedAfterDeadlineError } from "../src/domain/capture-knowledge.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { createProjectContextService } from "../src/services/project-context.ts";
import { createProjectListingService } from "../src/services/projects.ts";
import { createLogger } from "../src/observability/logger.ts";
import { memoryCaptureWriter, captureInput, capturedPage } from "./fixtures/capture-knowledge.ts";
import { memoryContextRepository } from "./fixtures/project-context.ts";
import { memoryKnowledgeRepository } from "./fixtures/knowledge-entry.ts";
import { inMemoryProjects } from "./fixtures/projects.ts";
import { memoryConnection } from "./fixtures/mcp.ts";

async function connect(capture?: CaptureService) {
  const fixture = memoryCaptureWriter(); const logs: string[] = [];
  const connection = await memoryConnection(createMcpServer({ search: memorySearch().service, projects: createProjectListingService(inMemoryProjects()),
    projectContext: createProjectContextService(memoryContextRepository()), knowledgeEntry: createKnowledgeEntryService(memoryKnowledgeRepository()),
    capture: capture ?? createCaptureService(fixture.writer, memoryContextRepository()),
    logger: createLogger({ environment: {}, destination: { write(line: string) { logs.push(line); } } }),
  }));
  await connection.initialize(); return { connection, logs, ...fixture };
}
describe("capture_knowledge MCP contract", () => {
  it("returns confirmed-after-deadline recovery without claiming a partial or unknown write", async () => {
    const recovery = { pageId: capturedPage.id, url: capturedPage.url, confirmedBatches: 1, totalBatches: 1,
      confirmedBlocks: 1, totalBlocks: 1, bodyComplete: true, doNotRetryCapture: true as const };
    const { connection, logs } = await connect({ capture: async () => { throw new WriteConfirmedAfterDeadlineError(recovery); } });
    try {
      const response = await connection.request("tools/call", { name: "capture_knowledge", arguments: captureInput });
      expect(response.result).toMatchObject({ isError: true, structuredContent: { error: { code: "WRITE_CONFIRMED_AFTER_DEADLINE", retryable: false }, recovery } });
      expect(logs.join("")).not.toContain(capturedPage.id); expect(logs.join("")).not.toContain(capturedPage.url);
    } finally { await connection.close(); }
  });
  it("advertises create-only non-idempotent annotations and exact allowed options", async () => {
    const { connection } = await connect();
    try {
      const response = await connection.request("tools/list");
      expect(response.result?.tools?.find((tool) => tool.name === "capture_knowledge")).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: { required: ["projectId", "title", "type"], additionalProperties: false,
          properties: { verification: { enum: ["Draft", "Hypothesis", "Needs Review"], default: "Draft" }, title: { maxLength: 200 } } },
        outputSchema: { type: "object" },
      });
    } finally { await connection.close(); }
  });
  it("creates using the shared service with structured/text parity and private diagnostics", async () => {
    const { connection, creates, appends, logs } = await connect();
    try {
      const response = await connection.request("tools/call", { name: "capture_knowledge", arguments: { ...captureInput, content: "private-body-sentinel" } });
      expect(response.result?.isError).not.toBe(true);
      expect(response.result?.structuredContent).toMatchObject({ entry: { ...capturedPage, verification: "Draft" }, body: { complete: true, blocksWritten: 1 } });
      expect(JSON.parse(response.result?.content?.[0]?.text ?? "{}")).toEqual(response.result?.structuredContent);
      expect(creates).toHaveLength(1); expect(appends).toHaveLength(1);
      expect(logs.join("")).not.toMatch(/private-body-sentinel|Captured note|70000000/);
    } finally { await connection.close(); }
  });
  it.each([{ ...captureInput, verification: "Verified" }, { ...captureInput, tags: ["new-private-tag"] }, { ...captureInput, privateKey: "private-value" }, { ...captureInput, sourceUrl: "invalid-private-url" }])("rejects invalid input without leaking values or writing", async (input) => {
    const { connection, creates, appends } = await connect();
    try {
      const response = await connection.request("tools/call", { name: "capture_knowledge", arguments: input });
      expect(response.result?.isError).toBe(true);
      if ("verification" in input) expect(JSON.stringify(response)).toContain("human");
      expect(JSON.stringify(response)).not.toMatch(/new-private-tag|privateKey|private-value|invalid-private-url/);
      expect(creates).toHaveLength(0); expect(appends).toHaveLength(0);
    } finally { await connection.close(); }
  });
  it("returns stable PARTIAL_WRITE recovery only to the caller, never logs", async () => {
    const recovery = { pageId: capturedPage.id, url: capturedPage.url, confirmedBatches: 1, totalBatches: 2,
      confirmedBlocks: 100, totalBlocks: 101, bodyComplete: false, failedBatchOutcome: "unknown" as const, doNotRetryCapture: true as const };
    const { connection, logs } = await connect({ capture: async () => { throw new PartialWriteError(recovery); } });
    try {
      const response = await connection.request("tools/call", { name: "capture_knowledge", arguments: captureInput });
      expect(response.result).toMatchObject({ isError: true, structuredContent: { error: { code: "PARTIAL_WRITE", retryable: false, correlationId: expect.any(String) }, recovery } });
      expect(JSON.parse(response.result?.content?.[0]?.text ?? "{}")).toEqual(response.result?.structuredContent);
      expect(logs.join("")).not.toContain(capturedPage.id); expect(logs.join("")).not.toContain(capturedPage.url);
    } finally { await connection.close(); }
  });
  it("keeps supported arrays inside the existing 16-element MCP bound", async () => {
    const { connection, creates } = await connect();
    try {
      const response = await connection.request("tools/call", { name: "capture_knowledge", arguments: { ...captureInput, filePaths: Array.from({ length: 10 }, (_, index) => "src/" + index) } });
      expect(response.result?.isError).not.toBe(true); expect(creates).toHaveLength(1);
    } finally { await connection.close(); }
  });
});
