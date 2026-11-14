import type { Client } from "@notionhq/client";
import * as z from "zod";
import type { KnowledgeEntryRepository, BodyBlock } from "../../domain/knowledge-entry.ts";
import type { RequestBudget } from "../../domain/project-context.ts";
import type { ValidatedDatabase } from "../../domain/notion-schema.ts";
import { canonicalNotionId } from "../../domain/notion-schema.ts";
import { DomainError, SchemaDriftError } from "../../domain/errors.ts";
import { mapKnowledge } from "./project-context.ts";
import { backtickFence } from "../../domain/markdown.ts";

const pageSchema = z.object({ object: z.literal("page"), id: z.uuid(), archived: z.boolean().optional(), in_trash: z.boolean().optional(),
  parent: z.object({ type: z.string(), data_source_id: z.string().optional() }), properties: z.record(z.string(), z.unknown()),
});
const pageList = z.object({ object: z.literal("list"), results: z.array(z.unknown()).max(100), has_more: z.boolean(), next_cursor: z.string().min(1).nullable() });
const richText = z.array(z.object({ plain_text: z.string(), href: z.string().nullable().optional(), annotations: z.object({
  bold: z.boolean().optional(), italic: z.boolean().optional(), strikethrough: z.boolean().optional(), code: z.boolean().optional(),
}).optional() }));
function invalid(): never { throw new SchemaDriftError([{ database: "knowledge", reason: "INVALID_METADATA" }]); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) return invalid(); return parsed.data; }
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href.replaceAll("(", "%28").replaceAll(")", "%29") : undefined; }
  catch { return undefined; }
}
function escapeLeading(text: string): string {
  return text.replace(/^(\s*)(#{1,6})(?=\s|$)/gm, "$1\\$2")
    .replace(/^(\s*)([-+])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)([-=_])(?=[-=_]{2,}\s*$)/gm, "$1\\$2");
}
function escape(text: string): string { return escapeLeading(text.replace(/([\\`*_\[\]<>~])/g, "\\$1")); }
function rich(value: unknown) {
  const parts = parse(richText, value);
  return { text: parts.map((part) => part.plain_text).join(""), markdown: escapeLeading(parts.map((part) => {
    let text = escape(part.plain_text);
    if (part.annotations?.code) {
      const fence = backtickFence(part.plain_text, 1);
      text = fence + " " + part.plain_text + " " + fence;
    }
    if (part.annotations?.bold) text = "**" + text + "**";
    if (part.annotations?.italic) text = "*" + text + "*";
    if (part.annotations?.strikethrough) text = "~~" + text + "~~";
    const href = safeUrl(part.href);
    return href ? "[" + text + "](" + href + ")" : text;
  }).join("")) };
}
export function mapBodyBlock(raw: unknown): BodyBlock {
  const base = parse(z.object({ object: z.literal("block"), id: z.uuid(), type: z.string().regex(/^[a-z0-9_]+$/), has_children: z.boolean() }), raw);
  const record = parse(z.record(z.string(), z.unknown()), raw);
  const supportedRich = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "toggle", "code"];
  const known = [...supportedRich, "equation", "child_page", "table_row", "image", "video", "audio", "file", "pdf", "bookmark", "embed", "link_preview", "table", "column", "column_list", "synced_block", "divider"];
  // Future unsupported payloads are opaque; do not attempt to interpret them.
  const payload = known.includes(base.type) ? parse(z.record(z.string(), z.unknown()), record[base.type] ?? {}) : {};
  let content = { text: "", markdown: "" };
  if (supportedRich.includes(base.type)) content = rich(payload.rich_text);
  if (base.type === "equation") { const text = parse(z.string(), payload.expression); content = { text, markdown: text }; }
  if (base.type === "child_page") { const text = parse(z.string(), payload.title); content = { text, markdown: escape(text) }; }
  const caption = payload.caption === undefined ? "" : rich(payload.caption).markdown;
  const external = payload.external as { url?: unknown } | undefined;
  const file = payload.file as { url?: unknown } | undefined;
  const url = safeUrl(payload.url ?? external?.url ?? file?.url);
  const checked = base.type === "to_do" ? parse(z.boolean(), payload.checked) : undefined;
  const language = base.type === "code" ? parse(z.string(), payload.language) : undefined;
  const cells = base.type === "table_row" ? parse(z.array(z.unknown()), payload.cells).map((cell) => rich(cell).markdown) : undefined;
  return Object.freeze({ id: base.id.toLowerCase(), type: base.type, hasChildren: base.has_children, ...content, caption,
    ...(url ? { url } : {}), ...(checked !== undefined ? { checked } : {}), ...(language !== undefined ? { language } : {}), ...(cells ? { cells: Object.freeze(cells) } : {}),
  });
}

export function createNotionKnowledgeEntryRepository(client: Client, schema: ValidatedDatabase,
  mapError: (error: unknown) => DomainError,
  withBudget: <T>(budget: RequestBudget, operation: () => Promise<T>) => Promise<T>,
): KnowledgeEntryRepository {
  return Object.freeze({
    async getEntry(pageId, budget) {
      try {
        const raw = await withBudget(budget, () => client.pages.retrieve({ page_id: pageId }));
        const page = parse(pageSchema, raw);
        if (page.archived || page.in_trash) throw new DomainError("NOT_FOUND");
        if (canonicalNotionId(page.id) !== pageId) return invalid();
        if (page.parent.type !== "data_source_id" || canonicalNotionId(page.parent.data_source_id ?? "") !== schema.dataSourceId) throw new DomainError("NOT_IN_KNOWLEDGE_DB");
        const entry = mapKnowledge(raw, schema);
        function property(key: string) {
          const definition = schema.properties[key];
          if (!definition) return invalid();
          const found = Object.values(page.properties).filter((value) => typeof value === "object" && value !== null && "id" in value && value.id === definition.id);
          if (found.length !== 1) return invalid();
          const value = parse(z.object({ id: z.string(), type: z.literal(definition.type) }).passthrough(), found[0]);
          return value;
        }
        const created = parse(z.iso.datetime({ offset: true }), property("created").created_time);
        const reasons = new Set<"request_budget" | "relation_limit">();
        async function relations(key: string): Promise<readonly string[]> {
          const field = property(key);
          const inline = parse(z.array(z.object({ id: z.uuid() })), field.relation);
          const ids = new Set(inline.map((item) => item.id.toLowerCase()));
          if (field.has_more !== true) return Object.freeze([...ids]);
          let cursor: string | undefined;
          const cursors = new Set<string>();
          try {
            for (;;) {
              const response = await withBudget(budget, () => client.pages.properties.retrieve({ page_id: pageId, property_id: field.id, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
              const result = parse(pageList, response);
              if (result.has_more !== (result.next_cursor !== null)) return invalid();
              for (const item of result.results) {
                const relation = parse(z.object({ object: z.literal("property_item"), type: z.literal("relation"), relation: z.object({ id: z.uuid() }) }), item);
                if (ids.size >= 1000 && !ids.has(relation.relation.id.toLowerCase())) { reasons.add("relation_limit"); return Object.freeze([...ids]); }
                ids.add(relation.relation.id.toLowerCase());
              }
              if (!result.has_more) break;
              if (cursors.has(result.next_cursor!)) return invalid();
              cursors.add(result.next_cursor!); cursor = result.next_cursor!;
            }
          } catch (error) {
            if (!(error instanceof DomainError && error.code === "REQUEST_BUDGET_EXCEEDED")) throw error;
            budget.assertActive(); reasons.add("request_budget");
          }
          return Object.freeze([...ids]);
        }
        const projectIds = await relations("project");
        const subprojectIds = await relations("subproject");
        return Object.freeze({ ...entry, title: entry.name, created, projectIds, subprojectIds, relationsTruncated: reasons.size > 0, relationTruncationReasons: Object.freeze([...reasons]) });
      } catch (error) { throw mapError(error); }
    },
    async listBlocks(blockId, cursor, budget) {
      try {
        const response = await withBudget(budget, () => client.blocks.children.list({ block_id: blockId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
        const result = parse(pageList, response);
        if (result.has_more !== (result.next_cursor !== null) || (result.has_more && result.next_cursor === cursor)) return invalid();
        return Object.freeze({ items: Object.freeze(result.results.map(mapBodyBlock)), hasMore: result.has_more, nextCursor: result.next_cursor });
      } catch (error) { throw mapError(error); }
    },
  } satisfies KnowledgeEntryRepository);
}
