import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { KnowledgeEntryService } from "../domain/knowledge-entry.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";
import { mapError } from "../domain/errors.ts";
import type { AppLogger } from "../observability/logger.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import { knowledgeEntryInputSchema, BODY_MAX_CHARACTERS, BODY_MAX_BLOCKS } from "../services/knowledge-entry.ts";

const reasons = z.enum(["request_budget", "depth_limit", "block_limit", "content_limit", "unsupported_block", "relation_limit"]);
const output = z.strictObject({
  entry: z.strictObject({
    id: z.uuid(), name: z.string(), title: z.string(), url: z.url(), created: z.iso.datetime({ offset: true }), lastUpdated: z.iso.datetime({ offset: true }),
    type: z.enum(NOTION_SCHEMA.knowledge.type.options).optional(), verification: z.enum(NOTION_SCHEMA.knowledge.verification.options).optional(),
    context: z.string().optional(), files: z.string().optional(), sourceUrl: z.url().optional(), tags: z.array(z.enum(NOTION_SCHEMA.knowledge.tags.options)),
    projectIds: z.array(z.uuid()).max(1000), subprojectIds: z.array(z.uuid()).max(1000), relationsTruncated: z.boolean(),
    relationTruncationReasons: z.array(z.enum(["request_budget", "relation_limit"])),
  }),
  content: z.strictObject({ markdown: z.string().max(BODY_MAX_CHARACTERS), truncated: z.boolean(), reasons: z.array(reasons),
    blocksRead: z.number().int().min(0).max(BODY_MAX_BLOCKS), unsupportedBlocks: z.number().int().min(0).max(BODY_MAX_BLOCKS) }),
  truncated: z.boolean(), cacheHit: z.boolean(), requestBudget: z.strictObject({
    maxRequests: z.number().int().positive(), usedRequests: z.number().int().min(0), maxDurationMs: z.number().positive(),
  }),
});
const input = { "~standard": { ...knowledgeEntryInputSchema["~standard"], validate(value: unknown) {
  const parsed = knowledgeEntryInputSchema.safeParse(value);
  return parsed.success ? { value: parsed.data } : { issues: [{ message: "Invalid get_knowledge_entry input. Supply pageId (Knowledge page UUID)." }] };
} } };

export function registerKnowledgeEntry(server: McpServer, service: KnowledgeEntryService, logger: AppLogger): void {
  server.registerTool("get_knowledge_entry", {
    description: "Read a Knowledge page by pageId UUID, returning mapped metadata, relations and bounded Markdown body. Inspect truncated flags and reasons; unsupported blocks and limits are explicit. No writes or full-text search.",
    inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (value) => withCorrelationId(async () => {
    try {
      const result = output.parse(await service.get(value));
      logger.info("get_knowledge_entry_completed", { blocks: result.content.blocksRead, truncated: result.truncated, cacheHit: result.cacheHit, requests: result.requestBudget.usedRequests });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = { error: mapError(error, getCorrelationId() ?? "unavailable") };
      logger.warn("get_knowledge_entry_failed", result);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  }));
}
