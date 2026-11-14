import { afterEach, describe, expect, it, vi } from "vitest";
import { searchInputSchema } from "../src/domain/search-knowledge.ts";
import { createSearchService } from "../src/services/search-knowledge.ts";
import { rankCandidate, compareSearchResults } from "../src/services/search-ranking.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { DomainError } from "../src/domain/errors.ts";
import { candidate, golden, memorySearch, otherSubproject } from "./fixtures/search-knowledge.ts";
import { project } from "./fixtures/projects.ts";
import { subproject } from "./fixtures/project-context.ts";
import { bodyBlock } from "./fixtures/knowledge-entry.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { memoryCaptureWriter, captureInput } from "./fixtures/capture-knowledge.ts";

afterEach(() => { vi.useRealTimers(); });
const metadata = { query: "deploy node", depth: "metadata" };
describe("search validation and golden ranking", () => {
  it.each([{}, { query: " " }, { query: "!!!" }, { query: "x".repeat(201) }, { query: "x", limit: 0 }, { query: "x", limit: 26 },
    { query: "x", limit: 1.5 }, { query: "x", projectId: "invalid" }, { query: "x", type: ["invented"] }, { query: "x", verification: ["invalid"] },
    { query: "x", tags: ["unknown"] }, { query: "x", tags: ["auth", "auth"] }, { query: "x", depth: "semantic" }, { query: "x", extra: true }])("rejects invalid input before I/O: %j", async (input) => {
    const f = memorySearch(); await expect(f.service.search(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); expect(f.calls).toEqual({ candidates: 0, entries: 0, blocks: 0 });
  });
  it("normalizes Unicode/case/whitespace and applies defaults", () => {
    expect(searchInputSchema.parse({ query: "  ＤＥＰＬＯＹ\n Node " })).toEqual({ query: "deploy node", depth: "auto", limit: 10 });
  });
  it("retains the shared 16-element input bound and rejects excessive query tokens", async () => {
    const f = memorySearch();
    await expect(f.service.search({ ...metadata, projectId: project.id, subprojectId: subproject.id, type: ["Implementation", "Reference", "Learning"], verification: ["Draft", "Hypothesis", "Verified", "Needs Review"], tags: ["auth", "backend", "testing"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(f.service.search({ query: Array.from({ length: 33 }, (_, i) => "a" + i).join(" ") })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(f.calls.candidates).toBe(0);
  });
  it("ranks the golden metadata dataset numerically and makes zero body calls", async () => {
    const f = memorySearch();
    const result = await f.service.search(metadata);
    expect(result.results.map((item) => [item.id, item.score])).toEqual([[golden[0]!.id, 1240], [golden[6]!.id, 295], [golden[1]!.id, 240], [golden[3]!.id, 105], [golden[2]!.id, 90], [golden[8]!.id, 90], [golden[9]!.id, 30]]);
    expect(result.results.every((item) => !item.bodyScanned)).toBe(true); expect(f.calls).toEqual({ candidates: 1, entries: 0, blocks: 0 });
    expect(result.diagnostics).toMatchObject({ bodiesScanned: 0, candidateScanComplete: true, truncated: false, requestCount: 1 });
  });
  it("scans bodies after metadata fills limit, then lets a body-only match outrank weak context", async () => {
    const rows = [candidate(1, { context: "deploy node" }), candidate(2)];
    const f = memorySearch(rows, new Map([[rows[1]!.id, "deploy node"]]));
    const result = await f.service.search({ query: "deploy node", limit: 1 });
    expect(f.calls.blocks).toBe(2); expect(result.results[0]).toMatchObject({ id: rows[1]!.id, score: 135, matchedIn: ["body"], bodyScanned: true });
    expect(result.diagnostics).toMatchObject({ bodiesScanned: 2, requestCount: 5, matchesEvaluated: 2, truncationReasons: ["result_limit"] });
  });
  it("matches tags, type, status, paths, URLs and relation IDs, not similar words", async () => {
    const f = memorySearch();
    expect((await f.service.search({ query: "deployment", depth: "metadata" })).results.map((item) => item.id)).toContain(golden[4]!.id);
    expect((await f.service.search({ query: "verified", depth: "metadata" })).results[0]?.id).toBe(golden[8]!.id);
    expect((await f.service.search({ query: "runbook", depth: "metadata" })).results[0]?.matchedIn).toContain("type");
    expect((await f.service.search({ query: project.id, depth: "metadata" })).results[0]?.matchedIn).toContain("project");
    expect((await f.service.search(metadata)).results.map((item) => item.id)).not.toContain(golden[7]!.id);
    expect((await f.service.search({ query: "unfindable", depth: "metadata" })).results).toEqual([]);
  });
  it("caps repeated-token inflation, gives phrase/multiple-field bonuses and deterministic ties", () => {
    const input = searchInputSchema.parse(metadata);
    expect(rankCandidate(candidate(1, { context: "deploy node" }), input).score).toBe(90);
    expect(rankCandidate(candidate(1, { context: "deploy node ".repeat(1000) }), input).score).toBe(90);
    expect(rankCandidate(candidate(1, { context: "node unrelated deploy" }), input).score).toBe(60);
    expect(rankCandidate(candidate(1, { context: "deploy node", files: "deploy/node" }), input).score).toBe(205);
    const a = rankCandidate(candidate(1, { name: "deploy node" }), input), b = rankCandidate(candidate(2, { name: "deploy node" }), input);
    expect([b, a].sort(compareSearchResults).map((item) => item.id)).toEqual([a.id, b.id]);
    const newer = { ...b, lastUpdated: "2026-11-12T00:00:00.000Z" }; expect([a, newer].sort(compareSearchResults)[0]).toBe(newer);
  });
  it("bounds useful snippets and safely represents quotes, newlines and Unicode", async () => {
    const f = memorySearch([candidate(1, { context: "x".repeat(400) + ' deploy node "quoted"\n😀' + "z".repeat(500) })]);
    const result = await f.service.search(metadata); expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(240); expect(result.results[0]!.snippet).toContain("deploy node"); expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });
  it("audit: centers snippets on whole-token evidence instead of an earlier nonmatching substring", async () => {
    const f = memorySearch([candidate(1, { context: "deployment " + "x".repeat(500) + " deploy node" })]);
    const result = await f.service.search(metadata);
    expect(result.results[0]!.score).toBe(90);
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(240);
    expect(result.results[0]!.snippet).toContain("deploy node");
  });
  it.each(["deployment", "redeploy", "deploy_node", "nodejs"])("ignores the partial-word collision %s when positioning snippets", async (collision) => {
    const f = memorySearch([candidate(1, { context: collision + " " + "x".repeat(500) + " deploy node actual evidence" })]);
    const result = await f.service.search(metadata), snippet = result.results[0]!.snippet;
    expect(snippet).toContain("deploy node actual evidence"); expect(snippet).not.toContain(collision);
    expect(snippet.length).toBeLessThanOrEqual(240); expect(snippet.startsWith("...")).toBe(true);
  });
  it("anchors the earliest whole-token occurrence regardless of query order or later repetitions", async () => {
    const context = "deployment " + "x".repeat(300) + " NODE first evidence " + "y".repeat(500) + " deploy node later evidence";
    const result = await memorySearch([candidate(1, { context })]).service.search(metadata);
    expect(result.results[0]!.snippet).toContain("NODE first evidence");
    expect(result.results[0]!.snippet).not.toContain("later evidence");
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(240);
  });
  it("preserves display offsets after Unicode lowercase expansion and repeated matching phrases", async () => {
    const context = "\u0130".repeat(300) + " " + "x".repeat(300) + " DEPLOY NODE first evidence " + "y".repeat(500) + " deploy node later evidence";
    const result = await memorySearch([candidate(1, { context })]).service.search(metadata);
    expect(result.results[0]!.snippet).toContain("DEPLOY NODE first evidence");
    expect(result.results[0]!.snippet).not.toContain("later evidence");
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(240);
  });
  it("applies filters together and rejects unrelated scope before candidate queries", async () => {
    const f = memorySearch();
    const result = await f.service.search({ ...metadata, projectId: project.id, subprojectId: subproject.id, type: ["Setup / Runbook"], verification: ["Needs Review"] });
    expect(result.results.map((item) => item.id)).not.toContain(golden[8]!.id);
    expect((await f.service.search({ query: "deployment", depth: "metadata", tags: ["deployment", "auth"] })).results).toEqual([]);
    const before = f.calls.candidates;
    await expect(f.service.search({ ...metadata, projectId: project.id, subprojectId: otherSubproject })).rejects.toMatchObject({ code: "INVALID_RELATION" });
    expect(f.calls.candidates).toBe(before);
    expect((await f.service.search({ ...metadata, subprojectId: otherSubproject })).results.map((item) => item.id)).toEqual([golden[8]!.id]);
  });
});

describe("search bounds, partial evaluation and deadlines", () => {
  it("caps candidates at 200 and bodies at 25 independently of result limit", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => candidate(i + 1, { name: "deploy node" })); const f = memorySearch(rows);
    const result = await f.service.search({ ...metadata, limit: 25 });
    expect(result.results).toHaveLength(25); expect(result.diagnostics).toMatchObject({ totalCandidatesRetrieved: 200, pagesRetrieved: 4, truncationReasons: ["candidate_limit", "result_limit"] });
    const auto = await f.service.search({ query: "deploy node", limit: 1 });
    expect(auto.diagnostics.bodyCandidatesSelected).toBe(25); expect(auto.diagnostics.requestCount).toBe(40); expect(auto.diagnostics.truncationReasons).toEqual(expect.arrayContaining(["body_candidate_limit", "request_budget"]));
    expect(f.calls.entries + f.calls.blocks + 4).toBe(40);
  });
  it("reports sparse pagination cap and rejects cursor cycles", async () => {
    const f = memorySearch(); let calls = 0;
    const repository = { async list() { return { items: [], hasMore: true, nextCursor: String(++calls) }; } };
    expect((await createSearchService(repository, f.scope, f.bodies).search(metadata)).diagnostics.truncationReasons).toEqual(["pagination_limit"]);
    await expect(createSearchService({ async list() { return { items: [], hasMore: true, nextCursor: "same" }; } }, f.scope, f.bodies).search(metadata)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
  it("preserves partial candidates when their shared attempt budget ends", async () => {
    const f = memorySearch(Array.from({ length: 51 }, (_, i) => candidate(i + 1, { context: "deploy" })));
    const service = createSearchService(f.repository, f.scope, f.bodies, () => createRequestBudget(1));
    const result = await service.search(metadata); expect(result.diagnostics).toMatchObject({ requestCount: 1, totalCandidatesRetrieved: 50, candidateScanComplete: false });
    expect(result.diagnostics.truncationReasons).toContain("request_budget");
  });
  it("counts nested block retrieval against the same budget and preserves partial content", async () => {
    const f = memorySearch([candidate(1)]); const root = { ...bodyBlock(1, "paragraph", "deploy"), hasChildren: true };
    f.bodyRepository.listBlocks = async (id, _cursor, budget) => { budget.consume(); return { items: [id === candidate().id ? root : bodyBlock(2, "paragraph", "node")], hasMore: false, nextCursor: null }; };
    const bodies = createKnowledgeEntryService(f.bodyRepository), service = createSearchService(f.repository, f.scope, bodies, () => createRequestBudget(3));
    const result = await service.search({ query: "deploy" }); expect(result.results[0]).toMatchObject({ bodyTruncated: true, bodyTruncationReasons: ["request_budget"] }); expect(result.diagnostics.requestCount).toBe(3);
  });
  it("does not dispose an externally owned body budget or change the default 20", async () => {
    const f = memorySearch([candidate(1)]); const factory = vi.fn(() => createRequestBudget()); const bodies = createKnowledgeEntryService(f.bodyRepository, factory);
    const budget = createRequestBudget(40);
    await bodies.get({ pageId: candidate().id }, budget); expect(factory).not.toHaveBeenCalled(); budget.assertActive(); expect(budget.signal.aborted).toBe(false); budget.dispose();
    expect((await bodies.get({ pageId: candidate().id })).requestBudget.maxRequests).toBe(20);
  });
  it("keeps concurrent searches isolated and does not deduplicate their budgets", async () => {
    const f = memorySearch(); const budgets: ReturnType<typeof createRequestBudget>[] = [];
    const service = createSearchService(f.repository, f.scope, f.bodies, () => { const budget = createRequestBudget(40); budgets.push(budget); return budget; });
    const result = await Promise.all([service.search(metadata), service.search(metadata)]);
    expect(budgets).toHaveLength(2); expect(budgets[0]).not.toBe(budgets[1]); expect(result.map((item) => item.diagnostics.requestCount)).toEqual([1, 1]);
  });
  it("expires pending candidate work and never caches its late completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); const f = memorySearch(); let release!: () => void; let pending = true;
    const repository = { async list() { if (pending) await new Promise<void>((resolve) => { release = resolve; }); return { items: [candidate(1, { name: "deploy" })], hasMore: false, nextCursor: null }; } };
    const service = createSearchService(repository, f.scope, f.bodies); const operation = expect(service.search(metadata)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(30_000); await operation; pending = false; release(); await vi.advanceTimersByTimeAsync(0);
    expect((await service.search(metadata)).diagnostics.cacheHit).toBe(false);
  });
  it("expires pending body work instead of returning metadata as a late success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); const f = memorySearch();
    const service = createSearchService(f.repository, f.scope, { get: async () => new Promise(() => {}) });
    const operation = expect(service.search({ query: "deploy" })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" }); await vi.advanceTimersByTimeAsync(30_000); await operation;
  });
  it.each(["RATE_LIMITED", "TIMEOUT", "DEPENDENCY_UNAVAILABLE"] as const)("marks body failures safely: %s", async (code) => {
    const f = memorySearch([candidate(1, { name: "deploy" })]); const service = createSearchService(f.repository, f.scope, { async get() { throw new DomainError(code); } });
    const result = await service.search({ query: "deploy" }); expect(result.diagnostics).toMatchObject({ bodyEvaluationComplete: false, bodiesNotScanned: 1, bodyFailures: [{ code, count: 1 }], truncationReasons: ["body_read_failed"] });
    expect(result.results[0]?.bodyScanned).toBe(false);
  });
  it("removes deleted/wrong-source candidates and reports changes", async () => {
    const f = memorySearch([candidate(1, { name: "deploy" })]); const service = createSearchService(f.repository, f.scope, { async get() { throw new DomainError("NOT_IN_KNOWLEDGE_DB"); } });
    const result = await service.search({ query: "deploy" }); expect(result.results).toEqual([]); expect(result.diagnostics.truncationReasons).toEqual(["candidate_changed"]);
  });
  it("reports incomplete relations and extracted content without caching them", async () => {
    const f = memorySearch([candidate(1, { name: "deploy", relationsTruncated: true })], new Map([[candidate().id, "deploy ".repeat(20_000)]]));
    const result = await f.service.search({ query: "deploy" }); expect(result.results[0]!.bodyTruncationReasons).toContain("content_limit"); expect(result.diagnostics.truncationReasons).toEqual(["body_truncated", "relation_limit"]);
    expect((await f.service.search({ query: "deploy" })).diagnostics.cacheHit).toBe(false);
  });
  it.each(["depth_limit", "block_limit", "unsupported_block"] as const)("propagates the existing body converter limit: %s", async (reason) => {
    const f = memorySearch([candidate(1, { name: "deploy" })]); let depth = 0;
    f.bodyRepository.listBlocks = async (_id, cursor, budget) => {
      budget.consume();
      const offset = Number(cursor ?? 0);
      const items = reason === "depth_limit" ? [{ ...bodyBlock(++depth, "paragraph", "deploy"), hasChildren: true }]
        : reason === "unsupported_block" ? [bodyBlock(1, "unsupported", "")]
          : Array.from({ length: 100 }, (_, i) => bodyBlock(offset + i + 1, "paragraph", "deploy"));
      return { items, hasMore: reason === "block_limit", nextCursor: reason === "block_limit" ? String(offset + 100) : null };
    };
    const result = await f.service.search({ query: "deploy" }); expect(result.results[0]!.bodyTruncationReasons).toContain(reason);
    expect(result.diagnostics.truncationReasons).toEqual(["body_truncated"]); expect(result.diagnostics.bodyEvaluationComplete).toBe(false);
  });
  it("rechecks scope after fresh page metadata changes during body retrieval", async () => {
    const f = memorySearch([candidate(1, { name: "deploy" })]); const getEntry = f.bodyRepository.getEntry;
    f.bodyRepository.getEntry = async (...args) => ({ ...await getEntry(...args), projectIds: [] });
    const result = await f.service.search({ query: "deploy", projectId: project.id });
    expect(result.results).toEqual([]); expect(result.diagnostics.truncationReasons).toEqual(["candidate_changed"]);
  });
  it.each(["project", "subproject"])("does not reject missing %s membership from incomplete relations", async (relation) => {
    const f = memorySearch([candidate(1, { name: "deploy" })]), getEntry = f.bodyRepository.getEntry;
    f.bodyRepository.getEntry = async (...args) => ({ ...await getEntry(...args),
      ...(relation === "project" ? { projectIds: [] } : { subprojectIds: [] }), relationsTruncated: true, relationTruncationReasons: ["relation_limit"] });
    const input = { query: "deploy", projectId: project.id, subprojectId: subproject.id };
    const result = await f.service.search(input);
    expect(result.results).toHaveLength(1); expect(result.results[0]).toMatchObject({ relationsTruncated: true, bodyScanned: true });
    expect(result.diagnostics).toMatchObject({ changedCandidates: 0, relationTruncatedCandidates: 1, truncationReasons: ["relation_limit"] });
    expect((await f.service.search(input)).diagnostics.cacheHit).toBe(false);
  });
  it("still rejects confirmed complete subproject mismatches", async () => {
    const f = memorySearch([candidate(1, { name: "deploy" })]), getEntry = f.bodyRepository.getEntry;
    f.bodyRepository.getEntry = async (...args) => ({ ...await getEntry(...args), subprojectIds: [] });
    const result = await f.service.search({ query: "deploy", subprojectId: subproject.id });
    expect(result.results).toEqual([]); expect(result.diagnostics).toMatchObject({ changedCandidates: 1, truncationReasons: ["candidate_changed"] });
  });
  it.each(["type", "verification", "tags"])("preserves truncation before rejecting a confirmed %s mismatch", async (field) => {
    const f = memorySearch([candidate(1, { name: "deploy", tags: ["deployment"] })]), getEntry = f.bodyRepository.getEntry;
    f.bodyRepository.getEntry = async (...args) => ({ ...await getEntry(...args), projectIds: [], relationsTruncated: true, relationTruncationReasons: ["request_budget"],
      ...(field === "type" ? { type: "Reference" as const } : field === "verification" ? { verification: "Verified" as const } : { tags: [] }) });
    const bodies = createKnowledgeEntryService(f.bodyRepository);
    const service = createSearchService(f.repository, f.scope, { async get(...args) {
      const full = await bodies.get(...args);
      return { ...full, content: { ...full.content, truncated: true, reasons: ["request_budget"] } };
    } });
    const result = await service.search({ query: "deploy", projectId: project.id, type: ["Setup / Runbook"], verification: ["Needs Review"], tags: ["deployment"] });
    expect(result.results).toEqual([]);
    expect(result.diagnostics).toMatchObject({ bodiesScanned: 1, bodiesTruncated: 1, changedCandidates: 1, relationTruncatedCandidates: 1,
      truncationReasons: ["body_truncated", "candidate_changed", "relation_limit", "request_budget"] });
  });
  it("requires a real scope and never converts authentication failures into partial success", async () => {
    const f = memorySearch(); await expect(f.service.search({ ...metadata, projectId: "10000000-0000-4000-8000-000000000099" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const service = createSearchService(f.repository, f.scope, { async get() { throw new DomainError("UNAUTHORIZED"); } });
    await expect(service.search({ query: "deploy" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("enforces the deadline during candidate pagination", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); const f = memorySearch(); let page = 0;
    const service = createSearchService({ async list(_input, _limit, _cursor, budget) { budget.consume(); if (++page > 1) return new Promise(() => {});
      return { items: [candidate(1, { name: "deploy" })], hasMore: true, nextCursor: "second" }; } }, f.scope, f.bodies);
    const operation = expect(service.search(metadata)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" }); await vi.advanceTimersByTimeAsync(30_000); await operation; expect(page).toBe(2);
  });
});

describe("search snapshot cache", () => {
  it("audit: an in-flight search cannot repopulate snapshots after actual capture-service invalidation", async () => {
    const rows = [candidate(1, { name: "deploy" })], f = memorySearch(rows);
    const list = f.repository.list; let release!: () => void, started!: () => void, first = true;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.repository.list = async (...args) => {
      const page = await list(...args);
      if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; started(); }); }
      return page;
    };
    const { writer } = memoryCaptureWriter(), create = writer.create;
    writer.create = async (...args) => { const created = await create(...args); rows.push(candidate(2, { name: "deploy new" })); return created; };
    const capture = createCaptureService(writer, f.scope, undefined, f.service.invalidate);
    const pending = f.service.search(metadata); await ready;
    await capture.capture(captureInput); release();
    const overlapping = await pending;
    expect(overlapping.diagnostics.truncationReasons).toContain("data_changed");
    const fresh = await f.service.search(metadata);
    expect(fresh.diagnostics).toMatchObject({ cacheHit: false, totalCandidatesRetrieved: 2 });
    expect((await f.service.search(metadata)).diagnostics.cacheHit).toBe(true);
  });
  it("hits normalized keys, preserves top-K flags and prevents result mutation poisoning", async () => {
    const f = memorySearch(); const first = await f.service.search({ ...metadata, limit: 1 });
    expect(first.diagnostics.truncationReasons).toEqual(["result_limit"]);
    const hit = await f.service.search({ query: "  DEPLOY  NODE ", depth: "metadata", limit: 1 });
    expect(hit.diagnostics).toMatchObject({ cacheHit: true, requestCount: 0, evaluationRequestCount: 1, countsSource: "cached_snapshot", truncated: true });
    (hit.results as unknown as { title: string }[])[0]!.title = "poison";
    expect((await f.service.search({ ...metadata, limit: 1 })).results[0]!.title).toBe("Deploy node");
  });
  it("expires at exactly 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); const f = memorySearch(); await f.service.search(metadata);
    await vi.advanceTimersByTimeAsync(59_999); expect((await f.service.search(metadata)).diagnostics.cacheHit).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect((await f.service.search(metadata)).diagnostics.cacheHit).toBe(false);
  });
  it("separates every result-changing filter, depth and limit", async () => {
    const f = memorySearch(); await f.service.search(metadata);
    for (const extra of [{ projectId: project.id }, { subprojectId: subproject.id }, { type: ["Setup / Runbook"] }, { verification: ["Needs Review"] }, { tags: ["deployment"] }, { depth: "auto" }, { limit: 1 }]) {
      expect((await f.service.search({ ...metadata, ...extra })).diagnostics.cacheHit).toBe(false);
    }
  });
  it("normalizes filter order and evicts the least recently used entry at 32", async () => {
    const f = memorySearch(); const input = { ...metadata, type: ["Reference", "Setup / Runbook"] };
    await f.service.search(input); expect((await f.service.search({ ...input, type: [...input.type].reverse() })).diagnostics.cacheHit).toBe(true);
    for (let i = 0; i < 32; i++) await f.service.search({ query: "unique" + i, depth: "metadata" });
    expect((await f.service.search(input)).diagnostics.cacheHit).toBe(false);
  });
  it("invalidates completed and in-flight snapshots", async () => {
    const f = memorySearch(); await f.service.search(metadata); f.service.invalidate(); expect((await f.service.search(metadata)).diagnostics.cacheHit).toBe(false);
    let release!: () => void; let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const service = createSearchService({ async list() { await new Promise<void>((resolve) => { release = resolve; started(); }); return { items: [], hasMore: false, nextCursor: null }; } }, f.scope, f.bodies);
    const operation = service.search(metadata); await ready; service.invalidate(); release(); expect((await operation).diagnostics.truncationReasons).toEqual(["data_changed"]);
  });
  it("does not extend reused body-cache content with a fresh 60-second snapshot", async () => {
    const f = memorySearch([candidate(1)]); await f.bodies.get({ pageId: candidate().id });
    const result = await f.service.search({ query: "unrelated" }); expect(result.diagnostics.bodyCacheHits).toBe(1); expect((await f.service.search({ query: "unrelated" })).diagnostics.cacheHit).toBe(false);
  });
  it("rejects oversized cache entries and evicts snapshots by serialized UTF-8 bytes", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => candidate(i + 1).id);
    const f = memorySearch(Array.from({ length: 25 }, (_, i) => candidate(i + 1, { name: "deploy node", projectIds: ids, subprojectIds: ids })));
    const large = { ...metadata, limit: 25 }; await f.service.search(large); expect((await f.service.search(large)).diagnostics.cacheHit).toBe(false);
    // One 25-result snapshot exceeds 1 MB. Five-result snapshots fit alone,
    // but three different keys cannot all fit in the 1 MB cache.
    const smaller = { ...metadata, limit: 5 }; await f.service.search(smaller);
    await f.service.search({ ...smaller, query: "deploy" }); await f.service.search({ ...smaller, query: "node" });
    expect((await f.service.search(smaller)).diagnostics.cacheHit).toBe(false);
  });
});
