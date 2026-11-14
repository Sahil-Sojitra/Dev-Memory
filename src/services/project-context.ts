import * as z from "zod";
import { DomainError, RequestValidationError } from "../domain/errors.ts";
import type { ContextPage, KnowledgeClassification, KnowledgeEntry, ProjectContextRepository, ProjectContextService, RequestBudget, ScanInfo } from "../domain/project-context.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";
import { createRequestBudget } from "./request-budget.ts";
export { createRequestBudget, CONTEXT_MAX_REQUESTS, CONTEXT_MAX_DURATION_MS } from "./request-budget.ts";

export const CONTEXT_SCAN_LIMIT = 500;
export const contextInputSchema = z.strictObject({
  projectId: z.uuid().transform((value) => value.toLowerCase()),
  subprojectId: z.uuid().transform((value) => value.toLowerCase()).optional(),
  recentLimit: z.number().int().min(1).max(25).default(10),
});

function budgetExceeded(error: unknown): boolean { return error instanceof DomainError && error.code === "REQUEST_BUDGET_EXCEEDED"; }
function info(scanned: number, reason: ScanInfo["reason"] = null): ScanInfo {
  return Object.freeze({ scanned, complete: reason === null, truncated: reason !== null, reason });
}

export function createProjectContextService(repository: ProjectContextRepository, budgetFactory: () => RequestBudget = createRequestBudget): ProjectContextService {
  return Object.freeze({ async get(input: unknown) {
    const parsed = contextInputSchema.safeParse(input);
    if (!parsed.success) throw new RequestValidationError([...new Set(parsed.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? "input");
      return ["projectId", "subprojectId", "recentLimit"].includes(name) ? name : "input";
    }))].map((field) => ({ field })));
    const value = parsed.data;
    const budget = budgetFactory();
    try {
      return await budget.run(async () => {
        const project = await budget.run(() => repository.getProject(value.projectId, budget));
        if (value.subprojectId) {
          let selected;
          try { selected = await budget.run(() => repository.getSubproject(value.subprojectId!, budget)); }
          catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") throw new DomainError("INVALID_RELATION"); throw error; }
          if (!selected.projectIds.includes(value.projectId)) throw new DomainError("INVALID_RELATION");
        }
        async function scan<T extends { readonly id: string }>(read: (limit: number, cursor?: string) => Promise<ContextPage<T>>) {
          const items: T[] = [];
          const seen = new Set<string>();
          const cursors = new Set<string>();
          let cursor: string | undefined;
          for (;;) {
            let page;
            try { page = await budget.run(() => read(Math.min(100, CONTEXT_SCAN_LIMIT - items.length), cursor)); }
            catch (error) { if (budgetExceeded(error)) { budget.assertActive(); return { items, scan: info(items.length, "request_budget") }; } throw error; }
            for (const item of page.items) {
              if (seen.has(item.id)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
              seen.add(item.id); items.push(item);
            }
            if (!page.hasMore) return { items, scan: info(items.length) };
            if (items.length >= CONTEXT_SCAN_LIMIT) return { items, scan: info(items.length, "scan_limit") };
            if (!page.nextCursor || cursors.has(page.nextCursor)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
            cursors.add(page.nextCursor); cursor = page.nextCursor;
          }
        }
        const subprojects = await scan((limit, cursor) => repository.listSubprojects(value.projectId, limit, cursor, budget));
        const scope = { projectId: value.projectId, ...(value.subprojectId ? { subprojectId: value.subprojectId } : {}) };
        async function list(category?: "setup" | "needsReview") {
          try {
            const page = await budget.run(() => repository.listKnowledge({ ...scope, limit: value.recentLimit, ...(category ? { category } : {}) }, budget));
            const items: readonly KnowledgeEntry[] = Object.freeze([...page.items].sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated) || a.id.localeCompare(b.id)));
            return { items, scan: info(items.length, page.hasMore ? "result_limit" : null) };
          } catch (error) { if (budgetExceeded(error)) { budget.assertActive(); return { items: [], scan: info(0, "request_budget") }; } throw error; }
        }
        const recent = await list();
        const setup = await list("setup");
        const review = await list("needsReview");
        const counts = await scan<KnowledgeClassification>((limit, cursor) => repository.scanKnowledge({ ...scope, limit, ...(cursor ? { cursor } : {}) }, budget));
        const byType: Record<string, number> = Object.fromEntries([...NOTION_SCHEMA.knowledge.type.options, "Unspecified"].map((name) => [name, 0]));
        const byVerification: Record<string, number> = Object.fromEntries([...NOTION_SCHEMA.knowledge.verification.options, "Unspecified"].map((name) => [name, 0]));
        for (const item of counts.items) { byType[item.type ?? "Unspecified"]!++; byVerification[item.verification ?? "Unspecified"]!++; }
        budget.assertActive();
        return Object.freeze({ project, ...(value.subprojectId ? { subprojectId: value.subprojectId } : {}),
          subprojects: Object.freeze(subprojects.items), knowledgeCounts: Object.freeze({ total: counts.items.length, byType: Object.freeze(byType), byVerification: Object.freeze(byVerification) }),
          recentKnowledge: recent.items, setupRunbooks: setup.items, needsReview: review.items,
          scan: Object.freeze({ subprojects: subprojects.scan, knowledgeCounts: counts.scan, recentKnowledge: recent.scan, setupRunbooks: setup.scan, needsReview: review.scan }),
          requestBudget: Object.freeze({ maxRequests: budget.maxRequests, usedRequests: budget.used, maxDurationMs: budget.maxDurationMs }),
        });
      });
    } finally { budget.dispose(); }
  } });
}
