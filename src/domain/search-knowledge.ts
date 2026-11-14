import * as z from "zod";
import { NOTION_SCHEMA } from "./schema-map.ts";
import type { KnowledgeEntry, ContextPage, RequestBudget } from "./project-context.ts";
import type { ContentLimitReason } from "./knowledge-entry.ts";
import type { ErrorCode } from "./errors.ts";

export const normalizeSearch = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export const searchTokens = (text: string): string[] => normalizeSearch(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
const choices = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).min(1).max(values.length)
  .refine((items) => new Set(items).size === items.length).transform((items) => [...items].sort());
export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).transform(normalizeSearch)
    .refine((value) => value.length <= 200 && searchTokens(value).length > 0 && new Set(searchTokens(value)).size <= 32),
  projectId: z.uuid().transform((value) => value.toLowerCase()).optional(),
  subprojectId: z.uuid().transform((value) => value.toLowerCase()).optional(),
  type: choices(NOTION_SCHEMA.knowledge.type.options).optional(),
  verification: choices(NOTION_SCHEMA.knowledge.verification.options).optional(),
  tags: choices(NOTION_SCHEMA.knowledge.tags.options).optional(),
  depth: z.enum(["metadata", "auto"]).default("auto"), limit: z.number().int().min(1).max(25).default(10),
}).refine((value) => Object.keys(value).length + (value.type?.length ?? 0) + (value.verification?.length ?? 0) + (value.tags?.length ?? 0) <= 16);
export type SearchInput = z.infer<typeof searchInputSchema>;
export interface SearchCandidate extends KnowledgeEntry {
  readonly projectIds: readonly string[]; readonly subprojectIds: readonly string[]; readonly relationsTruncated: boolean;
}
export interface SearchRepository {
  list(input: SearchInput, limit: number, cursor: string | undefined, budget: RequestBudget): Promise<ContextPage<SearchCandidate>>;
}
export const SEARCH_FIELDS = ["title", "context", "files", "sourceUrl", "tags", "type", "verification", "project", "subproject", "body"] as const;
export type SearchField = typeof SEARCH_FIELDS[number];
export interface ScorePart { readonly field: SearchField; readonly tokenMatches: number; readonly phraseMatch: boolean; readonly points: number }
export interface SearchResult {
  readonly id: string; readonly title: string; readonly url: string;
  readonly type?: SearchCandidate["type"]; readonly verification?: SearchCandidate["verification"];
  readonly projectIds: readonly string[]; readonly subprojectIds: readonly string[]; readonly relationsTruncated: boolean;
  readonly tags: SearchCandidate["tags"]; readonly lastUpdated: string;
  readonly snippet: string; readonly matchedIn: readonly SearchField[]; readonly score: number; readonly scoreBreakdown: readonly ScorePart[];
  readonly bodyScanned: boolean; readonly bodyTruncated: boolean; readonly bodyTruncationReasons: readonly ContentLimitReason[];
}
export const SEARCH_REASONS = ["candidate_limit", "pagination_limit", "body_candidate_limit", "request_budget", "body_truncated", "body_read_failed", "relation_limit", "candidate_changed", "result_limit", "data_changed"] as const;
export type SearchReason = typeof SEARCH_REASONS[number];
export interface SearchDiagnostics {
  readonly query: string; readonly depth: SearchInput["depth"];
  readonly totalCandidatesRetrieved: number; readonly metadataCandidatesEvaluated: number; readonly pagesRetrieved: number;
  readonly bodyCandidatesSelected: number; readonly bodiesScanned: number; readonly bodyCacheHits: number;
  readonly resultsReturned: number; readonly matchesEvaluated: number;
  readonly requestCount: number; readonly evaluationRequestCount: number; readonly maxRequests: number; readonly maxDurationMs: number;
  readonly candidateScanComplete: boolean; readonly bodyEvaluationComplete: boolean;
  readonly bodiesNotSelected: number; readonly bodiesNotScanned: number; readonly bodiesTruncated: number;
  readonly relationTruncatedCandidates: number; readonly changedCandidates: number;
  readonly bodyFailures: readonly { readonly code: ErrorCode; readonly count: number }[];
  readonly cacheHit: boolean; readonly cacheAgeMs: number; readonly countsSource: "invocation" | "cached_snapshot"; readonly evaluatedAt: string;
  readonly truncated: boolean; readonly truncationReasons: readonly SearchReason[];
}
export interface SearchResponse { readonly results: readonly SearchResult[]; readonly diagnostics: SearchDiagnostics }
export interface SearchService { search(input: unknown): Promise<SearchResponse>; invalidate(): void }
