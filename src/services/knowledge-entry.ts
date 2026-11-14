import * as z from "zod";
import { DomainError, RequestValidationError } from "../domain/errors.ts";
import type { KnowledgeBody, KnowledgeEntryRepository, KnowledgeEntryService, ContentLimitReason } from "../domain/knowledge-entry.ts";
import type { RequestBudget } from "../domain/project-context.ts";
import { createRequestBudget } from "./request-budget.ts";
import { renderBlock } from "./notion-markdown.ts";

export const knowledgeEntryInputSchema = z.strictObject({ pageId: z.uuid().transform((value) => value.toLowerCase()) });
export const BODY_MAX_DEPTH = 5;
export const BODY_MAX_BLOCKS = 500;
export const BODY_MAX_CHARACTERS = 100_000;
const CACHE_MAX_ENTRIES = 32;
const CACHE_MAX_CHARACTERS = 1_000_000;
const CACHE_TTL_MS = 30_000;

export function createKnowledgeEntryService(repository: KnowledgeEntryRepository, budgetFactory: () => RequestBudget = createRequestBudget): KnowledgeEntryService {
  // Optional process-local acceleration only. Notion metadata is always reread.
  const cache = new Map<string, { body: KnowledgeBody; expires: number }>();
  let cacheCharacters = 0;
  function remove(key: string) { const item = cache.get(key); if (item) { cacheCharacters -= item.body.markdown.length; cache.delete(key); } }
  return Object.freeze({ async get(input: unknown) {
    const parsed = knowledgeEntryInputSchema.safeParse(input);
    if (!parsed.success) throw new RequestValidationError([{ field: "pageId" }]);
    const budget = budgetFactory();
    try {
      return await budget.run(async () => {
        const entry = await budget.run(() => repository.getEntry(parsed.data.pageId, budget));
        const key = entry.id + ":" + entry.lastUpdated;
        for (const [oldKey, item] of cache) {
          if (item.expires <= performance.now() || (oldKey.startsWith(entry.id + ":") && oldKey !== key)) remove(oldKey);
        }
        let body = cache.get(key)?.body;
        const cacheHit = body !== undefined;
        if (body) { const item = cache.get(key)!; cache.delete(key); cache.set(key, item); }
        if (!body) {
          const reasons = new Set<ContentLimitReason>();
          const seen = new Set<string>();
          const parts: string[] = [];
          let characters = 0;
          let blocksRead = 0;
          let unsupportedBlocks = 0;
          let stopped = false;
          function append(text: string, prefix: string) {
            if (!text) return;
            const rendered = (parts.length ? "\n\n" : "") + text.split("\n").map((line) => prefix + line).join("\n");
            const remaining = BODY_MAX_CHARACTERS - characters;
            parts.push(rendered.slice(0, remaining));
            characters += Math.min(remaining, rendered.length);
            if (rendered.length > remaining) { reasons.add("content_limit"); stopped = true; }
          }
          async function walk(id: string, depth: number, prefix = ""): Promise<void> {
            if (blocksRead >= BODY_MAX_BLOCKS) { reasons.add("block_limit"); stopped = true; return; }
            let cursor: string | undefined;
            const cursors = new Set<string>();
            for (;;) {
              const page = await budget.run(() => repository.listBlocks(id, cursor, budget));
              for (const block of page.items) {
                budget.assertActive();
                if (blocksRead >= BODY_MAX_BLOCKS) { reasons.add("block_limit"); stopped = true; return; }
                if (seen.has(block.id)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
                seen.add(block.id); blocksRead++;
                const rendered = renderBlock(block);
                if (!rendered.supported) { unsupportedBlocks++; reasons.add("unsupported_block"); }
                append(rendered.text, prefix);
                if (stopped) return;
                if (block.hasChildren && rendered.supported) {
                  if (depth >= BODY_MAX_DEPTH) reasons.add("depth_limit");
                  else {
                    const childPrefix = block.type === "quote" || block.type === "callout" ? prefix + "> "
                      : block.type === "numbered_list_item" ? prefix + "   "
                        : ["table", "column", "column_list", "synced_block"].includes(block.type) ? prefix : prefix + "  ";
                    await walk(block.id, depth + 1, childPrefix);
                  }
                }
                if (stopped) return;
              }
              if (!page.hasMore) return;
              if (blocksRead >= BODY_MAX_BLOCKS) { reasons.add("block_limit"); stopped = true; return; }
              if (characters >= BODY_MAX_CHARACTERS) { reasons.add("content_limit"); stopped = true; return; }
              if (!page.nextCursor || cursors.has(page.nextCursor)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
              cursors.add(page.nextCursor); cursor = page.nextCursor;
            }
          }
          try { await walk(entry.id, 0); }
          catch (error) {
            if (!(error instanceof DomainError && error.code === "REQUEST_BUDGET_EXCEEDED")) throw error;
            budget.assertActive(); // Overall expiry must never become a late success.
            reasons.add("request_budget");
          }
          budget.assertActive();
          body = Object.freeze({ markdown: parts.join(""), truncated: reasons.size > 0, reasons: Object.freeze([...reasons]), blocksRead, unsupportedBlocks });
          // Never reuse incomplete bodies or cache after an expired invocation.
          if (!body.truncated) {
            remove(key);
            while (cache.size >= CACHE_MAX_ENTRIES || cacheCharacters + body.markdown.length > CACHE_MAX_CHARACTERS) remove(cache.keys().next().value!);
            cache.set(key, { body, expires: performance.now() + CACHE_TTL_MS });
            cacheCharacters += body.markdown.length;
          }
        }
        budget.assertActive();
        return Object.freeze({ entry, content: body, truncated: entry.relationsTruncated || body.truncated, cacheHit,
          requestBudget: Object.freeze({ maxRequests: budget.maxRequests, usedRequests: budget.used, maxDurationMs: budget.maxDurationMs }),
        });
      });
    } finally { budget.dispose(); }
  } });
}
