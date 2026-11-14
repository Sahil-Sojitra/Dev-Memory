import { searchInputSchema } from "../domain/search-knowledge.ts";
import type { SearchService, SearchRepository, SearchResponse, SearchCandidate, SearchReason, SearchInput, SearchResult } from "../domain/search-knowledge.ts";
import { DomainError, RequestValidationError } from "../domain/errors.ts";
import type { ErrorCode } from "../domain/errors.ts";
import type { KnowledgeEntryService } from "../domain/knowledge-entry.ts";
import type { ProjectContextRepository, RequestBudget } from "../domain/project-context.ts";
import { createRequestBudget } from "./request-budget.ts";
import { validateProjectScope } from "./project-scope.ts";
import { rankCandidate, compareSearchResults } from "./search-ranking.ts";

export const SEARCH_MAX_REQUESTS = 40;
export const SEARCH_MAX_CANDIDATES = 200;
export const SEARCH_PAGE_SIZE = 50;
export const SEARCH_MAX_PAGES = 4;
export const SEARCH_MAX_BODIES = 25;
export const SEARCH_CACHE_TTL_MS = 60_000;
export const SEARCH_CACHE_ENTRIES = 32;
export const SEARCH_CACHE_BYTES = 1_000_000;
function key(input: SearchInput): string {
  return JSON.stringify([input.query, input.projectId ?? null, input.subprojectId ?? null, input.type ?? [], input.verification ?? [], input.tags ?? [], input.depth, input.limit]);
}
function passesFilters(candidate: SearchCandidate, input: SearchInput): boolean {
  // A partial relation can prove membership, but cannot prove non-membership.
  // These candidates already passed Notion's complete-relation query filters.
  return (!input.projectId || candidate.projectIds.includes(input.projectId) || candidate.relationsTruncated)
    && (!input.subprojectId || candidate.subprojectIds.includes(input.subprojectId) || candidate.relationsTruncated)
    && (!input.type || (candidate.type !== undefined && input.type.includes(candidate.type)))
    && (!input.verification || (candidate.verification !== undefined && input.verification.includes(candidate.verification)))
    && (!input.tags || input.tags.every((tag) => candidate.tags.includes(tag)));
}
export function createSearchService(repository: SearchRepository, scope: ProjectContextRepository, bodies: KnowledgeEntryService,
  budgetFactory: () => RequestBudget = () => createRequestBudget(SEARCH_MAX_REQUESTS)): SearchService {
  const cache = new Map<string, { json: string; bytes: number; created: number }>();
  let cacheBytes = 0;
  let generation = 0;
  function remove(cacheKey: string) { const entry = cache.get(cacheKey); if (entry) { cacheBytes -= entry.bytes; cache.delete(cacheKey); } }
  return Object.freeze({
    invalidate() { generation++; cache.clear(); cacheBytes = 0; },
    async search(input: unknown): Promise<SearchResponse> {
      const parsed = searchInputSchema.safeParse(input);
      if (!parsed.success) throw new RequestValidationError([...new Set(parsed.error.issues.map((issue) => {
        const field = String(issue.path[0] ?? "input"); return ["query", "projectId", "subprojectId", "type", "verification", "tags", "depth", "limit"].includes(field) ? field : "input";
      }))].map((field) => ({ field })));
      const value = parsed.data;
      const budget = budgetFactory();
      const initialGeneration = generation;
      try {
        return await budget.run(async () => {
          for (const [cacheKey, entry] of cache) if (performance.now() - entry.created >= SEARCH_CACHE_TTL_MS) remove(cacheKey);
          const cacheKey = key(value); const hit = cache.get(cacheKey);
          if (hit) {
            cache.delete(cacheKey); cache.set(cacheKey, hit);
            const snapshot = JSON.parse(hit.json) as SearchResponse;
            return { ...snapshot, diagnostics: { ...snapshot.diagnostics, cacheHit: true, cacheAgeMs: Math.max(0, Math.floor(performance.now() - hit.created)), countsSource: "cached_snapshot", requestCount: budget.used } };
          }
          if (value.projectId) await validateProjectScope(scope, { projectId: value.projectId, ...(value.subprojectId ? { subprojectId: value.subprojectId } : {}) }, budget);
          else if (value.subprojectId) await budget.run(() => scope.getSubproject(value.subprojectId!, budget));
          const reasons = new Set<SearchReason>();
          const candidates = new Map<string, SearchCandidate>();
          const ranked = new Map<string, SearchResult>();
          let pagesRetrieved = 0;
          let candidateScanComplete = false;
          let cursor: string | undefined;
          const cursors = new Set<string>();
          while (pagesRetrieved < SEARCH_MAX_PAGES && candidates.size < SEARCH_MAX_CANDIDATES) {
            let page;
            try { page = await budget.run(() => repository.list(value, Math.min(SEARCH_PAGE_SIZE, SEARCH_MAX_CANDIDATES - candidates.size), cursor, budget)); }
            catch (error) {
              if (!(error instanceof DomainError && error.code === "REQUEST_BUDGET_EXCEEDED")) throw error;
              budget.assertActive(); reasons.add("request_budget"); break;
            }
            pagesRetrieved++;
            for (const candidate of page.items) {
              if (candidates.has(candidate.id)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
              candidates.set(candidate.id, candidate); ranked.set(candidate.id, rankCandidate(candidate, value));
            }
            if (!page.hasMore) { candidateScanComplete = true; break; }
            if (!page.nextCursor || cursors.has(page.nextCursor)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
            cursors.add(page.nextCursor); cursor = page.nextCursor;
          }
          if (!candidateScanComplete && !reasons.has("request_budget")) reasons.add(candidates.size >= SEARCH_MAX_CANDIDATES ? "candidate_limit" : "pagination_limit");
          const selected = value.depth === "auto" ? [...candidates.values()].sort((a, b) =>
            Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, SEARCH_MAX_BODIES) : [];
          if (value.depth === "auto" && candidates.size > selected.length) reasons.add("body_candidate_limit");
          let bodiesScanned = 0; let bodyCacheHits = 0; let bodiesTruncated = 0; let changedCandidates = 0;
          const failures = new Map<ErrorCode, number>();
          for (const candidate of selected) {
            if (budget.used >= budget.maxRequests) { reasons.add("request_budget"); break; }
            try {
              // Reuse the real Knowledge service, including nested blocks and
              // Markdown conversion, with this exact search-owned budget.
              const full = await budget.run(() => bodies.get({ pageId: candidate.id }, budget));
              const refreshed: SearchCandidate = full.entry;
              // Preserve completed read diagnostics even if refreshed metadata
              // subsequently proves that this candidate no longer matches.
              bodiesScanned++; if (full.cacheHit) bodyCacheHits++;
              if (full.content.truncated) { bodiesTruncated++; reasons.add("body_truncated"); }
              if (full.entry.relationsTruncated) reasons.add("relation_limit");
              if (full.content.reasons.includes("request_budget") || full.entry.relationTruncationReasons.includes("request_budget")) reasons.add("request_budget");
              if (!passesFilters(refreshed, value)) {
                ranked.delete(candidate.id); candidates.set(candidate.id, refreshed); changedCandidates++; reasons.add("candidate_changed"); continue;
              }
              candidates.set(candidate.id, refreshed);
              ranked.set(candidate.id, rankCandidate(refreshed, value, full.content));
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              budget.assertActive();
              if (error.code === "REQUEST_BUDGET_EXCEEDED") { reasons.add("request_budget"); break; }
              if (error.code === "NOT_FOUND" || error.code === "NOT_IN_KNOWLEDGE_DB") {
                ranked.delete(candidate.id); changedCandidates++; reasons.add("candidate_changed");
              } else if (["RATE_LIMITED", "TIMEOUT", "DEPENDENCY_UNAVAILABLE"].includes(error.code)) {
                reasons.add("body_read_failed"); failures.set(error.code, (failures.get(error.code) ?? 0) + 1);
              } else throw error;
            }
          }
          const relationTruncatedCandidates = [...candidates.values()].filter((candidate) => candidate.relationsTruncated).length;
          if (relationTruncatedCandidates) reasons.add("relation_limit");
          const matches = [...ranked.values()].filter((result) => result.score > 0).sort(compareSearchResults);
          if (matches.length > value.limit) reasons.add("result_limit");
          if (initialGeneration !== generation) reasons.add("data_changed");
          const results = Object.freeze(matches.slice(0, value.limit));
          const response: SearchResponse = Object.freeze({ results, diagnostics: Object.freeze({
            query: value.query, depth: value.depth, totalCandidatesRetrieved: candidates.size, metadataCandidatesEvaluated: candidates.size,
            pagesRetrieved, bodyCandidatesSelected: selected.length, bodiesScanned, bodyCacheHits, resultsReturned: results.length, matchesEvaluated: matches.length,
            requestCount: budget.used, evaluationRequestCount: budget.used, maxRequests: budget.maxRequests, maxDurationMs: budget.maxDurationMs,
            candidateScanComplete, bodyEvaluationComplete: value.depth === "metadata" || (bodiesScanned === candidates.size && bodiesTruncated === 0 && changedCandidates === 0),
            bodiesNotSelected: value.depth === "auto" ? candidates.size - selected.length : 0, bodiesNotScanned: selected.length - bodiesScanned,
            bodiesTruncated, relationTruncatedCandidates, changedCandidates,
            bodyFailures: Object.freeze([...failures].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, count]) => Object.freeze({ code, count }))),
            cacheHit: false, cacheAgeMs: 0, countsSource: "invocation", evaluatedAt: new Date().toISOString(),
            truncated: reasons.size > 0, truncationReasons: Object.freeze([...reasons].sort()),
          }) });
          budget.assertActive();
          // A requested top-K boundary is cacheable with its flags. Incomplete
          // evaluation is never cached. Store serialized snapshots so callers
          // cannot mutate the cache through returned DTOs.
          if (bodyCacheHits === 0 && [...reasons].every((reason) => reason === "result_limit")) {
            const json = JSON.stringify(response); const bytes = Buffer.byteLength(json, "utf8");
            budget.assertActive();
            if (bytes <= SEARCH_CACHE_BYTES && generation === initialGeneration) {
              remove(cacheKey);
              while (cache.size >= SEARCH_CACHE_ENTRIES || cacheBytes + bytes > SEARCH_CACHE_BYTES) remove(cache.keys().next().value!);
              cache.set(cacheKey, { json, bytes, created: performance.now() }); cacheBytes += bytes;
            }
          }
          return response;
        });
      } finally { budget.dispose(); }
    },
  });
}
