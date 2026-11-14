import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectContextService, createRequestBudget, CONTEXT_SCAN_LIMIT } from "../src/services/project-context.ts";
import { DomainError } from "../src/domain/errors.ts";
import { memoryContextRepository, knowledge, subproject } from "./fixtures/project-context.ts";
import { project } from "./fixtures/projects.ts";
import type { KnowledgeEntry } from "../src/domain/project-context.ts";

afterEach(() => vi.useRealTimers());
describe("project context service", () => {
  it("returns independently overlapping lists, counts and associated subprojects", async () => {
    const result = await createProjectContextService(memoryContextRepository()).get({ projectId: project.id });
    expect(result.project).toEqual(project);
    expect(result.subprojects).toEqual([subproject]);
    for (const list of [result.recentKnowledge, result.setupRunbooks, result.needsReview]) expect(list).toEqual([knowledge]);
    expect(result.knowledgeCounts).toMatchObject({ total: 1, byType: { "Setup / Runbook": 1, Reference: 0 }, byVerification: { "Needs Review": 1, Verified: 0 } });
    expect(Object.values(result.scan).every((scan) => scan.complete && !scan.truncated)).toBe(true);
    expect(result.requestBudget.usedRequests).toBe(6);
  });
  it("applies independent list limits, newest-first sorting and explicit truncation", async () => {
    const newer = { ...knowledge, id: "30000000-0000-4000-8000-000000000002", lastUpdated: "2026-11-03T00:00:00Z" };
    const result = await createProjectContextService(memoryContextRepository([knowledge, newer])).get({ projectId: project.id, recentLimit: 1 });
    for (const items of [result.recentKnowledge, result.setupRunbooks, result.needsReview]) expect(items).toEqual([newer]);
    expect(result.scan.setupRunbooks).toMatchObject({ complete: false, reason: "result_limit" });
    expect(result.knowledgeCounts.total).toBe(2);
  });
  it("rejects an absent project before related queries", async () => {
    const repo = memoryContextRepository();
    const list = vi.spyOn(repo, "listKnowledge");
    await expect(createProjectContextService(repo).get({ projectId: subproject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(list).not.toHaveBeenCalled();
  });
  it.each(["missing", "unrelated"])("rejects a %s subproject with INVALID_RELATION", async (scenario) => {
    const repo = memoryContextRepository([], scenario === "missing" ? [] : [{ ...subproject, projectIds: [] }]);
    await expect(createProjectContextService(repo).get({ projectId: project.id, subprojectId: subproject.id })).rejects.toMatchObject({ code: "INVALID_RELATION" });
  });
  it("scopes every knowledge query while still returning all project subprojects", async () => {
    const repo = memoryContextRepository();
    const list = vi.spyOn(repo, "listKnowledge");
    const scan = vi.spyOn(repo, "scanKnowledge");
    const result = await createProjectContextService(repo).get({ projectId: project.id.toUpperCase(), subprojectId: subproject.id, recentLimit: 25 });
    expect(result.subprojects).toEqual([subproject]);
    for (const [input] of [...list.mock.calls, ...scan.mock.calls]) expect(input).toMatchObject({ projectId: project.id, subprojectId: subproject.id });
    expect(list.mock.calls.map(([input]) => input.category)).toEqual([undefined, "setup", "needsReview"]);
  });
  it.each([{}, { projectId: "invalid" }, { projectId: project.id, subprojectId: "invalid" }, ...[0, 26, 1.5, "2"].map((recentLimit) => ({ projectId: project.id, recentLimit })), { projectId: project.id, privateCallerKey: "private" }])("rejects invalid inputs before I/O", async (input) => {
    const repo = memoryContextRepository();
    const retrieve = vi.spyOn(repo, "getProject");
    await expect(createProjectContextService(repo).get(input)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(retrieve).not.toHaveBeenCalled();
  });
  it("marks scan-capped counts as lower bounds and never scans beyond 500", async () => {
    const entries: KnowledgeEntry[] = Array.from({ length: CONTEXT_SCAN_LIMIT + 1 }, (_, index) => ({ ...knowledge, id: "30000000-0000-4000-8000-" + String(index).padStart(12, "0") }));
    const result = await createProjectContextService(memoryContextRepository(entries)).get({ projectId: project.id });
    expect(result.knowledgeCounts.total).toBe(500);
    expect(result.scan.knowledgeCounts).toEqual({ scanned: 500, complete: false, truncated: true, reason: "scan_limit" });
  });
  it("returns every associated subproject across pages and flags only genuinely incomplete scans", async () => {
    const children = Array.from({ length: 501 }, (_, index) => ({ ...subproject, id: "20000000-0000-4000-8000-" + String(index).padStart(12, "0") }));
    const complete = await createProjectContextService(memoryContextRepository([], children.slice(0, 101))).get({ projectId: project.id });
    expect(complete.subprojects).toHaveLength(101);
    expect(complete.scan.subprojects.complete).toBe(true);
    const partial = await createProjectContextService(memoryContextRepository([], children)).get({ projectId: project.id });
    expect(partial.subprojects).toHaveLength(500);
    expect(partial.scan.subprojects).toMatchObject({ complete: false, reason: "scan_limit" });
  });
  it("marks an exact-cap exhausted dataset complete", async () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({ ...knowledge, id: "30000000-0000-4000-8000-" + String(index).padStart(12, "0") }));
    const result = await createProjectContextService(memoryContextRepository(entries)).get({ projectId: project.id });
    expect(result.knowledgeCounts.total).toBe(500);
    expect(result.scan.knowledgeCounts.complete).toBe(true);
  });
  it("returns flagged partial results on shared budget exhaustion", async () => {
    const result = await createProjectContextService(memoryContextRepository(), () => createRequestBudget(3)).get({ projectId: project.id });
    expect(result.recentKnowledge).toHaveLength(1);
    expect(result.setupRunbooks).toEqual([]);
    expect(result.scan.knowledgeCounts).toMatchObject({ complete: false, reason: "request_budget" });
    expect(result.requestBudget.usedRequests).toBe(3);
  });
  it("never claims a project exists when the budget prevents validation", async () => {
    await expect(createProjectContextService(memoryContextRepository(), () => createRequestBudget(0)).get({ projectId: project.id })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
  });
  it("keeps request budgets isolated and rejects starts after the deadline", async () => {
    vi.useFakeTimers();
    const first = createRequestBudget(2, 100);
    const second = createRequestBudget(2, 100);
    first.consume(); first.consume();
    expect(() => first.consume()).toThrow(DomainError);
    expect(second.used).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(() => second.consume()).toThrow(DomainError);
  });
  it("rejects cursor cycles and duplicate records rather than inflating counts", async () => {
    const repo = memoryContextRepository();
    repo.scanKnowledge = async (_input, budget) => { budget.consume(); return { items: [knowledge], hasMore: true, nextCursor: "cycle" }; };
    await expect(createProjectContextService(repo).get({ projectId: project.id })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
  it("counts unset select properties under the explicit Unspecified bucket", async () => {
    const { type: _type, verification: _verification, ...unset } = knowledge;
    const result = await createProjectContextService(memoryContextRepository([unset])).get({ projectId: project.id });
    expect(result.knowledgeCounts.byType.Unspecified).toBe(1);
    expect(result.knowledgeCounts.byVerification.Unspecified).toBe(1);
    expect(result.setupRunbooks).toEqual([]);
    expect(result.needsReview).toEqual([]);
  });
});
