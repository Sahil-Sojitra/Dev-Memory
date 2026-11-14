import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { SEARCH_FIELDS, SEARCH_REASONS, searchInputSchema } from "../domain/search-knowledge.ts";
import type { SearchService } from "../domain/search-knowledge.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";
import { ERROR_CATALOG, mapError } from "../domain/errors.ts";
import type { AppLogger } from "../observability/logger.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";

const count = z.number().int().min(0);
const output = z.strictObject({
  results: z.array(z.strictObject({
    id: z.uuid(), title: z.string(), url: z.url(), type: z.enum(NOTION_SCHEMA.knowledge.type.options).optional(), verification: z.enum(NOTION_SCHEMA.knowledge.verification.options).optional(),
    projectIds: z.array(z.uuid()).max(1000), subprojectIds: z.array(z.uuid()).max(1000), relationsTruncated: z.boolean(), tags: z.array(z.enum(NOTION_SCHEMA.knowledge.tags.options)),
    lastUpdated: z.iso.datetime({ offset: true }), snippet: z.string().max(240), matchedIn: z.array(z.enum(SEARCH_FIELDS)), score: count,
    scoreBreakdown: z.array(z.strictObject({ field: z.enum(SEARCH_FIELDS), tokenMatches: count, phraseMatch: z.boolean(), points: count })),
    bodyScanned: z.boolean(), bodyTruncated: z.boolean(), bodyTruncationReasons: z.array(z.enum(["request_budget", "depth_limit", "block_limit", "content_limit", "unsupported_block", "relation_limit"])),
  })).max(25),
  diagnostics: z.strictObject({
    query: z.string().min(1).max(200), depth: z.enum(["metadata", "auto"]), totalCandidatesRetrieved: count.max(200), metadataCandidatesEvaluated: count.max(200), pagesRetrieved: count.max(4),
    bodyCandidatesSelected: count.max(25), bodiesScanned: count.max(25), bodyCacheHits: count.max(25), resultsReturned: count.max(25), matchesEvaluated: count.max(200),
    requestCount: count.max(40), evaluationRequestCount: count.max(40), maxRequests: z.literal(40), maxDurationMs: z.literal(30_000),
    candidateScanComplete: z.boolean(), bodyEvaluationComplete: z.boolean(), bodiesNotSelected: count.max(200), bodiesNotScanned: count.max(25), bodiesTruncated: count.max(25),
    relationTruncatedCandidates: count.max(200), changedCandidates: count.max(25), bodyFailures: z.array(z.strictObject({ code: z.enum(Object.keys(ERROR_CATALOG) as [keyof typeof ERROR_CATALOG, ...(keyof typeof ERROR_CATALOG)[]]), count })),
    cacheHit: z.boolean(), cacheAgeMs: count, countsSource: z.enum(["invocation", "cached_snapshot"]), evaluatedAt: z.iso.datetime({ offset: true }), truncated: z.boolean(), truncationReasons: z.array(z.enum(SEARCH_REASONS)),
  }),
});
const input = { "~standard": { ...searchInputSchema["~standard"], validate(value: unknown) {
  const result = searchInputSchema.safeParse(value);
  return result.success ? { value: result.data } : { issues: [{ message: "Invalid search_knowledge input. Supply a nonblank keyword query (1-200 characters), optional approved filters, depth metadata/auto and limit 1-25. Combined input elements must not exceed 16." }] };
} } };
export function registerSearch(server: McpServer, service: SearchService, logger: AppLogger): void {
  server.registerTool("search_knowledge", {
    description: "Bounded keyword search, not semantic search. Filter project/subproject, Type/Verification (OR within each) and tags (all required). Metadata depth makes no body calls; auto scans up to 25 newest candidates before the final limit. Inspect truncation and cached-snapshot diagnostics; this is not a full-database completeness guarantee.",
    inputSchema: input, outputSchema: output, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (value) => withCorrelationId(async () => {
    try {
      const result = output.parse(await service.search(value));
      logger.info("search_knowledge_completed", { candidates: result.diagnostics.totalCandidatesRetrieved, bodies: result.diagnostics.bodiesScanned,
        results: result.results.length, requests: result.diagnostics.requestCount, cacheHit: result.diagnostics.cacheHit, truncated: result.diagnostics.truncated });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { error: mapError(error, getCorrelationId() ?? "unavailable") };
      logger.warn("search_knowledge_failed", result);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  }));
}
