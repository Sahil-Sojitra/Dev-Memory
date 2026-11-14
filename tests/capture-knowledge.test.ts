import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { markdownToBlocks } from "../src/services/markdown-capture.ts";
import { validateCapture, PartialWriteError } from "../src/domain/capture-knowledge.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { DomainError, mapError } from "../src/domain/errors.ts";
import { memoryContextRepository, subproject, knowledge } from "./fixtures/project-context.ts";
import { memoryCaptureWriter, captureInput, capturedPage } from "./fixtures/capture-knowledge.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const fixture = memoryCaptureWriter();
  const scope = memoryContextRepository();
  return { ...fixture, scope, service: createCaptureService(fixture.writer, scope) };
}
describe("capture input safety and create-only workflow", () => {
  it.each([false, true])("never labels fully confirmed writes PARTIAL_WRITE at final deadline expiry (body=%s)", async (withBody) => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { writer, creates, appends } = memoryCaptureWriter(); const create = writer.create; const append = writer.append;
    writer.create = async (...args) => { const result = await create(...args); if (!withBody) clock = 51; return result; };
    writer.append = async (...args) => { await append(...args); clock = 51; };
    const service = createCaptureService(writer, memoryContextRepository(), () => createRequestBudget(20, 50));
    const error = await service.capture({ ...captureInput, ...(withBody ? { content: "Body" } : {}) }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "WRITE_CONFIRMED_AFTER_DEADLINE", recovery: { pageId: capturedPage.id, bodyComplete: true, doNotRetryCapture: true } });
    expect(error).not.toBeInstanceOf(PartialWriteError); expect(creates).toHaveLength(1); expect(appends).toHaveLength(withBody ? 1 : 0);
  });
  it("creates required fields with Draft by default and no body append", async () => {
    const { service, creates, appends } = setup();
    const result = await service.capture(captureInput);
    expect(result.entry).toEqual({ ...capturedPage, verification: "Draft" });
    expect(creates).toHaveLength(1); expect(creates[0]?.verification).toBe("Draft"); expect(appends).toHaveLength(0);
    expect(result.requestBudget.usedRequests).toBe(4);
  });
  it.each(["Draft", "Hypothesis", "Needs Review"])("accepts %s without promotion", async (verification) => {
    const { service, creates } = setup(); await service.capture({ ...captureInput, verification });
    expect(creates[0]?.verification).toBe(verification);
  });
  it("rejects Verified in the service with a human-review explanation and zero I/O", async () => {
    const { service, scope, creates } = setup(); const read = vi.spyOn(scope, "getProject");
    const error = await service.capture({ ...captureInput, verification: "Verified" }).catch((value: unknown) => value);
    expect(mapError(error, "synthetic")).toMatchObject({ code: "VERIFICATION_REQUIRES_HUMAN", retryable: false, message: expect.stringContaining("human") });
    expect(read).not.toHaveBeenCalled(); expect(creates).toHaveLength(0);
  });
  it.each([
    {}, { ...captureInput, projectId: "invalid" }, { ...captureInput, subprojectId: "invalid" },
    { ...captureInput, title: "  " }, { ...captureInput, title: "x".repeat(201) }, { ...captureInput, type: "Unknown" },
    { ...captureInput, tags: ["invented"] }, { ...captureInput, tags: ["auth", "auth"] }, { ...captureInput, verification: "verified" },
    { ...captureInput, content: "   " }, { ...captureInput, content: "x".repeat(20_001) },
    { ...captureInput, content: "\u0001".repeat(10_000) }, { ...captureInput, context: "x".repeat(2001) },
    { ...captureInput, sourceUrl: "not a URL" }, { ...captureInput, sourceUrl: "javascript:alert(1)" },
    { ...captureInput, sourceUrl: "https://user:password@example.test/" }, { ...captureInput, sourceUrl: "https://example.test/" + "x".repeat(2000) },
    { ...captureInput, filePaths: [""] }, { ...captureInput, filePaths: ["x".repeat(201)] },
    { ...captureInput, filePaths: Array.from({ length: 11 }, (_, i) => String(i)) },
    { ...captureInput, filePaths: Array.from({ length: 10 }, (_, i) => String(i)), tags: ["auth", "testing"] },
    { ...captureInput, secretUnknownKey: "private" },
  ])("rejects invalid input before reads or writes", async (input) => {
    const { service, writer, scope, creates, appends } = setup();
    const prepare = vi.spyOn(writer, "prepare"); const read = vi.spyOn(scope, "getProject");
    await expect(service.capture(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(prepare).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(creates).toHaveLength(0); expect(appends).toHaveLength(0);
  });
  it("rejects missing projects and invalid or unrelated subprojects before creation", async () => {
    for (const scenario of ["project", "missing", "unrelated"]) {
      const { writer, creates } = memoryCaptureWriter();
      const scope = memoryContextRepository([], scenario === "missing" ? [] : [{ ...subproject, projectIds: [] }]);
      const service = createCaptureService(writer, scope);
      await expect(service.capture({ ...captureInput, ...(scenario === "project" ? { projectId: knowledge.id } : { subprojectId: subproject.id }) })).rejects.toMatchObject({ code: scenario === "project" ? "NOT_FOUND" : "INVALID_RELATION" });
      expect(creates).toHaveLength(0);
    }
  });
  it("warns on normalized duplicate titles without overwriting or blocking creation", async () => {
    const { writer, creates } = memoryCaptureWriter();
    const scope = memoryContextRepository([{ ...knowledge, name: "  Captured    NOTE  " }]);
    const query = vi.spyOn(scope, "listKnowledge");
    const result = await createCaptureService(writer, scope).capture(captureInput);
    expect(result.warnings).toEqual(["DUPLICATE_TITLE"]); expect(result.duplicateCheck).toEqual({ complete: true, scanned: 1, matches: 1 });
    expect(query.mock.calls[0]?.[0]).toMatchObject({ projectId: captureInput.projectId }); expect(creates).toHaveLength(1);
  });
  it("bounds duplicate discovery and reports incomplete scans", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({ ...knowledge, id: "90000000-0000-4000-8000-" + String(i).padStart(12, "0") }));
    const { writer } = memoryCaptureWriter();
    const result = await createCaptureService(writer, memoryContextRepository(entries)).capture(captureInput);
    expect(result.duplicateCheck).toMatchObject({ complete: false, scanned: 500 }); expect(result.warnings).toContain("DUPLICATE_CHECK_INCOMPLETE");
  });
  it("rejects cyclic duplicate cursors before writing", async () => {
    const { writer, creates } = memoryCaptureWriter(); const scope = memoryContextRepository();
    scope.listKnowledge = async (_input, budget) => { budget.consume(); return { items: [], hasMore: true, nextCursor: "cycle" }; };
    await expect(createCaptureService(writer, scope).capture(captureInput)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" }); expect(creates).toHaveLength(0);
  });
  it("splits append batches and reports confirmed progress on a later failure", async () => {
    const { writer, creates, appends } = memoryCaptureWriter(); const original = writer.append;
    writer.append = async (page, blocks, budget) => { if (appends.length === 1) throw new DomainError("RATE_LIMITED"); await original(page, blocks, budget); };
    const service = createCaptureService(writer, memoryContextRepository());
    const error = await service.capture({ ...captureInput, content: Array.from({ length: 201 }, (_, i) => "- Item " + i).join("\n") }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect(error).toMatchObject({ code: "PARTIAL_WRITE", recovery: { pageId: capturedPage.id, url: capturedPage.url,
      confirmedBatches: 1, totalBatches: 3, confirmedBlocks: 100, totalBlocks: 201, bodyComplete: false, failedBatchOutcome: "rejected", doNotRetryCapture: true } });
    expect(creates).toHaveLength(1); expect(appends).toHaveLength(1);
  });
  it("reserves enough write attempts before creating a page", async () => {
    const { writer, creates } = memoryCaptureWriter();
    await expect(createCaptureService(writer, memoryContextRepository(), () => createRequestBudget(4)).capture({ ...captureInput, content: "Body" })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    expect(creates).toHaveLength(0);
  });
  it("does not append when page creation fails", async () => {
    const { writer, appends } = memoryCaptureWriter(); writer.create = async () => { throw new DomainError("FORBIDDEN"); };
    await expect(createCaptureService(writer, memoryContextRepository()).capture({ ...captureInput, content: "Body" })).rejects.toMatchObject({ code: "FORBIDDEN" }); expect(appends).toHaveLength(0);
  });
});
describe("Markdown capture subset", () => {
  it("maps headings, paragraphs, lists, tasks, quotes, divider and fenced code in order", () => {
    const content = "# Heading\n\nParagraph\ncontinued\n\n- item\n1. numbered\n- [x] done\n> quoted\n---\n```typescript\nconst value = 1;\n```";
    expect(markdownToBlocks(content)).toEqual([
      { type: "heading_1", text: "Heading" }, { type: "paragraph", text: "Paragraph\ncontinued" }, { type: "bulleted_list_item", text: "item" },
      { type: "numbered_list_item", text: "numbered" }, { type: "to_do", text: "done", checked: true }, { type: "quote", text: "quoted" },
      { type: "divider", text: "" }, { type: "code", text: "const value = 1;", language: "typescript" },
    ]);
  });
  it("preserves literal unsupported syntax, Unicode and unclosed code text", () => {
    expect(markdownToBlocks("Nested literal\n  - child\n[link](https://example.test) 😀")[0]?.text).toContain("  - child");
    expect(markdownToBlocks("~~~unknown\ncode 😀")).toEqual([{ type: "code", text: "code 😀", language: "unknown" }]);
  });
  it("rejects more than 500 blocks before I/O", () => {
    expect(() => markdownToBlocks("- item\n".repeat(501))).toThrow();
    expect(markdownToBlocks(undefined)).toEqual([]);
    expect(validateCapture(captureInput).verification).toBe("Draft");
  });
});
