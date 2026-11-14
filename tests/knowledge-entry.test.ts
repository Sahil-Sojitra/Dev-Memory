import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeEntryService, BODY_MAX_CHARACTERS } from "../src/services/knowledge-entry.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { renderBlock } from "../src/services/notion-markdown.ts";
import { bodyBlock, detail, memoryKnowledgeRepository } from "./fixtures/knowledge-entry.ts";
import { DomainError } from "../src/domain/errors.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("readable block conversion", () => {
  it.each([
    ["paragraph", "hello"], ["heading_1", "# hello"], ["heading_2", "## hello"], ["heading_3", "### hello"],
    ["bulleted_list_item", "- hello"], ["numbered_list_item", "1. hello"], ["to_do", "- [ ] hello"],
    ["quote", "> hello"], ["callout", "> hello"], ["toggle", "**hello**"], ["divider", "---"],
    ["equation", "$$\nhello\n$$"], ["table", ""], ["column", ""], ["column_list", ""], ["synced_block", ""],
  ])("renders %s", (type, expected) => expect(renderBlock(bodyBlock(1, type, "hello"))).toEqual({ text: expected, supported: true }));
  it("renders checked tasks, multiline quotes, tables and media", () => {
    expect(renderBlock({ ...bodyBlock(1, "to_do", "done"), checked: true }).text).toBe("- [x] done");
    expect(renderBlock(bodyBlock(1, "quote", "a\nb")).text).toBe("> a\n> b");
    expect(renderBlock({ ...bodyBlock(1, "table_row"), cells: ["a|b", "c\nd"] }).text).toBe("| a\\|b | c<br>d |");
    for (const type of ["image", "video", "audio", "file", "pdf", "bookmark", "embed", "link_preview"]) {
      expect(renderBlock({ ...bodyBlock(1, type), url: "https://example.test/file", caption: "caption" })).toEqual({ text: "[caption](https://example.test/file)", supported: true });
    }
  });
  it("preserves code containing triple backticks without closing its fence", () => {
    expect(renderBlock({ ...bodyBlock(1, "code", "a```b"), language: "javascript" }).text).toBe("````javascript\na```b\n````");
  });
  it("marks unsupported blocks and unexpanded child pages visibly", () => {
    expect(renderBlock(bodyBlock(1, "future_block"))).toEqual({ text: "[Unsupported Notion block: future_block]", supported: false });
    expect(renderBlock(bodyBlock(1, "child_page", "Nested page")).supported).toBe(false);
    expect(renderBlock(bodyBlock(1, "image")).supported).toBe(false);
  });
});
describe("knowledge entry service", () => {
  it("returns metadata and complete body with an isolated shared budget", async () => {
    const result = await createKnowledgeEntryService(memoryKnowledgeRepository()).get({ pageId: detail.id.toUpperCase() });
    expect(result.entry).toEqual(detail);
    expect(result.content).toMatchObject({ markdown: "Readable content", truncated: false, reasons: [], blocksRead: 1 });
    expect(result.requestBudget.usedRequests).toBe(2);
  });
  it.each([{}, { pageId: "invalid" }, { pageId: detail.id, secretCallerKey: "private" }])("rejects invalid input before I/O", async (input) => {
    const repo = memoryKnowledgeRepository();
    const retrieve = vi.spyOn(repo, "getEntry");
    await expect(createKnowledgeEntryService(repo).get(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("walks nested blocks in document order", async () => {
    const parent = { ...bodyBlock(1, "bulleted_list_item", "Parent"), hasChildren: true };
    const repo = memoryKnowledgeRepository([parent, bodyBlock(3, "paragraph", "After")]);
    const original = repo.listBlocks;
    repo.listBlocks = async (id, cursor, budget) => {
      if (id === parent.id) { budget.consume(); return { items: [bodyBlock(2, "paragraph", "Child")], hasMore: false, nextCursor: null }; }
      return original(id, cursor, budget);
    };
    const result = await createKnowledgeEntryService(repo).get({ pageId: detail.id });
    expect(result.content.markdown).toBe("- Parent\n\n  Child\n\nAfter");
    expect(result.requestBudget.usedRequests).toBe(3);
  });
  it("bounds nesting depth and reports unsupported content without expanding it", async () => {
    const repo = memoryKnowledgeRepository();
    let index = 0;
    repo.listBlocks = async (_id, _cursor, budget) => { budget.consume(); return { items: [{ ...bodyBlock(++index), hasChildren: true }], hasMore: false, nextCursor: null }; };
    const result = await createKnowledgeEntryService(repo).get({ pageId: detail.id });
    expect(result.content).toMatchObject({ truncated: true, reasons: ["depth_limit"], blocksRead: 6 });
    const unsupported = await createKnowledgeEntryService(memoryKnowledgeRepository([{ ...bodyBlock(1, "future_block"), hasChildren: true }])).get({ pageId: detail.id });
    expect(unsupported.content).toMatchObject({ truncated: true, reasons: ["unsupported_block"], unsupportedBlocks: 1 });
    expect(unsupported.requestBudget.usedRequests).toBe(2);
  });
  it("returns partial content on attempt exhaustion and never caches it", async () => {
    const repo = memoryKnowledgeRepository(Array.from({ length: 101 }, (_, i) => bodyBlock(i)));
    const read = vi.spyOn(repo, "listBlocks");
    const service = createKnowledgeEntryService(repo, () => createRequestBudget(2));
    for (let i = 0; i < 2; i++) {
      const result = await service.get({ pageId: detail.id });
      expect(result.content).toMatchObject({ truncated: true, reasons: ["request_budget"], blocksRead: 100 });
      expect(result.cacheHit).toBe(false);
    }
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("requires metadata validation before returning any partial result", async () => {
    await expect(createKnowledgeEntryService(memoryKnowledgeRepository(), () => createRequestBudget(0)).get({ pageId: detail.id })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
  });
  it("caps body characters and blocks while retaining explicit partial flags", async () => {
    const long = await createKnowledgeEntryService(memoryKnowledgeRepository([bodyBlock(1, "paragraph", "x".repeat(BODY_MAX_CHARACTERS + 1))])).get({ pageId: detail.id });
    expect(long.content.markdown).toHaveLength(BODY_MAX_CHARACTERS);
    expect(long.content.reasons).toContain("content_limit");
    const many = await createKnowledgeEntryService(memoryKnowledgeRepository(Array.from({ length: 501 }, (_, i) => bodyBlock(i)))).get({ pageId: detail.id });
    expect(many.content).toMatchObject({ blocksRead: 500, truncated: true, reasons: ["block_limit"] });
    const exact = await createKnowledgeEntryService(memoryKnowledgeRepository(Array.from({ length: 500 }, (_, i) => bodyBlock(i)))).get({ pageId: detail.id });
    expect(exact.content.truncated).toBe(false);
  });
  it("rejects repeated cursors and duplicate block IDs", async () => {
    const repo = memoryKnowledgeRepository([bodyBlock(), bodyBlock()]);
    await expect(createKnowledgeEntryService(repo).get({ pageId: detail.id })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    repo.listBlocks = async (_id, _cursor, budget) => { budget.consume(); return { items: [], hasMore: true, nextCursor: "cycle" }; };
    await expect(createKnowledgeEntryService(repo).get({ pageId: detail.id })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
  it("rechecks metadata on hits and invalidates body cache using Last Updated", async () => {
    const repo = memoryKnowledgeRepository();
    const body = vi.spyOn(repo, "listBlocks");
    const metadata = vi.spyOn(repo, "getEntry");
    const service = createKnowledgeEntryService(repo);
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(false);
    const hit = await service.get({ pageId: detail.id });
    expect(hit.cacheHit).toBe(true);
    expect(hit.requestBudget.usedRequests).toBe(1);
    metadata.mockImplementation(async (_id, budget) => { budget.consume(); return { ...detail, lastUpdated: "2026-11-02T00:00:00.000Z" }; });
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(false);
    expect(body).toHaveBeenCalledTimes(2);
    metadata.mockRejectedValue(new DomainError("NOT_IN_KNOWLEDGE_DB"));
    await expect(service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "NOT_IN_KNOWLEDGE_DB" });
  });
  it("expires cache entries and evicts them at the entry bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const repo = memoryKnowledgeRepository();
    const service = createKnowledgeEntryService(repo);
    await service.get({ pageId: detail.id });
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(false);
    repo.getEntry = async (id, budget) => { budget.consume(); return { ...detail, id }; };
    for (let i = 1; i <= 33; i++) await service.get({ pageId: "50000000-0000-4000-8000-" + String(i).padStart(12, "0") });
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a stalled body read at the overall deadline instead of publishing partial success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const repo = memoryKnowledgeRepository();
    repo.listBlocks = async () => new Promise(() => {});
    const pending = createKnowledgeEntryService(repo, () => createRequestBudget(20, 50)).get({ pageId: detail.id });
    const error = pending.catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);
    expect(await error).toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds aggregate cache content independently of its entry count", async () => {
    const repo = memoryKnowledgeRepository([bodyBlock(1, "paragraph", "x".repeat(BODY_MAX_CHARACTERS))]);
    repo.getEntry = async (id, budget) => { budget.consume(); return { ...detail, id }; };
    const service = createKnowledgeEntryService(repo);
    const id = (index: number) => "50000000-0000-4000-8000-" + String(index).padStart(12, "0");
    for (let i = 0; i < 11; i++) expect((await service.get({ pageId: id(i) })).content.truncated).toBe(false);
    expect((await service.get({ pageId: id(10) })).cacheHit).toBe(true);
    expect((await service.get({ pageId: id(0) })).cacheHit).toBe(false);
  });
  it("does not cache unsupported content or fetch children after the block limit", async () => {
    const unsupported = memoryKnowledgeRepository([bodyBlock(1, "future_block")]);
    const read = vi.spyOn(unsupported, "listBlocks");
    const service = createKnowledgeEntryService(unsupported);
    await service.get({ pageId: detail.id });
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    const blocks = Array.from({ length: 500 }, (_, i) => ({ ...bodyBlock(i), hasChildren: i === 499 }));
    const bounded = memoryKnowledgeRepository(blocks);
    const requests = vi.spyOn(bounded, "listBlocks");
    const result = await createKnowledgeEntryService(bounded).get({ pageId: detail.id });
    expect(result.content.reasons).toContain("block_limit");
    expect(requests).toHaveBeenCalledTimes(5);
  });
});
