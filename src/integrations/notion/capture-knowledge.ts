import type { Client } from "@notionhq/client";
import * as z from "zod";
import { DomainError, SchemaDriftError } from "../../domain/errors.ts";
import { validateCapture } from "../../domain/capture-knowledge.ts";
import type { CaptureWriter, CaptureBindings, CaptureBlock } from "../../domain/capture-knowledge.ts";
import type { RequestBudget } from "../../domain/project-context.ts";
import type { ValidatedSchema } from "../../domain/notion-schema.ts";
import { canonicalNotionId } from "../../domain/notion-schema.ts";
import { NOTION_SCHEMA } from "../../domain/schema-map.ts";

type Create = Parameters<Client["pages"]["create"]>[0];
type Block = Parameters<Client["blocks"]["children"]["append"]>[0]["children"][number];
const MAX_PAYLOAD_BYTES = 450_000;
function invalid(): never { throw new SchemaDriftError([{ database: "knowledge", reason: "INVALID_METADATA" }]); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) return invalid(); return parsed.data; }
export function captureRichText(text: string) {
  const result: { type: "text"; text: { content: string } }[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 2000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    result.push({ type: "text", text: { content: text.slice(offset, end) } }); offset = end;
  }
  if (result.length > 100) throw new DomainError("VALIDATION_ERROR");
  return result;
}
export function captureBlockPayload(block: CaptureBlock): Block {
  const rich_text = captureRichText(block.text);
  switch (block.type) {
    case "divider": return { object: "block", type: "divider", divider: {} };
    case "code": {
      const languages = ["javascript", "typescript", "python", "json", "bash", "shell", "sql", "html", "css", "java", "go", "rust", "plain text"] as const;
      const language = languages.find((value) => value === block.language?.toLowerCase()) ?? "plain text";
      return { object: "block", type: "code", code: { rich_text, language } };
    }
    case "to_do": return { object: "block", type: "to_do", to_do: { rich_text, checked: block.checked ?? false } };
    case "paragraph": return { object: "block", type: "paragraph", paragraph: { rich_text } };
    case "heading_1": return { object: "block", type: "heading_1", heading_1: { rich_text } };
    case "heading_2": return { object: "block", type: "heading_2", heading_2: { rich_text } };
    case "heading_3": return { object: "block", type: "heading_3", heading_3: { rich_text } };
    case "bulleted_list_item": return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text } };
    case "numbered_list_item": return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text } };
    case "quote": return { object: "block", type: "quote", quote: { rich_text } };
  }
}
function payloadLimit(body: object) { if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_PAYLOAD_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE"); }

export function createNotionCaptureWriter(client: Client, schemas: ValidatedSchema,
  mapError: (error: unknown) => DomainError,
  withBudget: <T>(budget: RequestBudget, operation: () => Promise<T>) => Promise<T>,
  mutate: <T>(budget: RequestBudget, method: "POST" | "PATCH", path: string, operation: () => Promise<T>) => Promise<T>,
): CaptureWriter {
  const schema = schemas.knowledge;
  const issued = new WeakMap<CaptureBindings, RequestBudget>();
  const createdPages = new WeakMap<RequestBudget, Set<string>>();
  return Object.freeze({
    async prepare(budget) {
      try {
        const raw = await withBudget(budget, () => client.dataSources.retrieve({ data_source_id: schema.dataSourceId }));
        const source = parse(z.object({ object: z.literal("data_source"), id: z.string(), parent: z.object({ type: z.literal("database_id"), database_id: z.string() }), properties: z.record(z.string(), z.unknown()) }), raw);
        if (canonicalNotionId(source.id) !== schema.dataSourceId || canonicalNotionId(source.parent.database_id) !== schema.databaseId) return invalid();
        const properties: Record<string, string> = Object.create(null) as Record<string, string>;
        const options: Record<string, Readonly<Record<string, string>>> = Object.create(null) as Record<string, Readonly<Record<string, string>>>;
        for (const [key, expected] of Object.entries(NOTION_SCHEMA.knowledge)) {
          const field = parse(z.object({ id: z.string(), type: z.literal(expected.type) }).passthrough(), source.properties[expected.name]);
          if (field.id !== schema.properties[key]?.id) return invalid();
          properties[key] = field.id;
          if ("options" in expected) {
            const choices = parse(z.object({ options: z.array(z.object({ id: z.string().min(1), name: z.string() })) }), field[expected.type]);
            if (choices.options.length !== expected.options.length || new Set(choices.options.map((item) => item.name)).size !== choices.options.length
              || new Set(choices.options.map((item) => item.id)).size !== choices.options.length
              || expected.options.some((name) => !choices.options.some((item) => item.name === name))) return invalid();
            options[key] = Object.freeze(Object.fromEntries(choices.options.map((item) => [item.name, item.id])));
          }
          if ("relation" in expected) {
            const relation = parse(z.object({ database_id: z.string().optional(), data_source_id: z.string().optional() }), field.relation);
            const target = schemas[expected.relation];
            if ((!relation.database_id && !relation.data_source_id)
              || (relation.database_id && canonicalNotionId(relation.database_id) !== target.databaseId)
              || (relation.data_source_id && canonicalNotionId(relation.data_source_id) !== target.dataSourceId)) return invalid();
          }
        }
        const bindings = Object.freeze({ properties: Object.freeze(properties), options: Object.freeze(options) });
        issued.set(bindings, budget); return bindings;
      } catch (error) { throw mapError(error); }
    },
    async create(input, bindings, budget) {
      const value = validateCapture(input); // Defense in depth; Verified is never writable.
      if (issued.get(bindings) !== budget) throw new DomainError("FORBIDDEN");
      issued.delete(bindings); // One creation per issued preflight capability.
      function option(key: string, name: string): string { const id = bindings.options[key]?.[name]; if (!id) return invalid(); return id; }
      const ids = bindings.properties;
      const properties: Create["properties"] = {
        [ids.name!]: { title: captureRichText(value.title) },
        [ids.type!]: { select: { id: option("type", value.type) } },
        [ids.verification!]: { select: { id: option("verification", value.verification) } },
        [ids.project!]: { relation: [{ id: value.projectId }] },
      };
      if (value.subprojectId) properties[ids.subproject!] = { relation: [{ id: value.subprojectId }] };
      if (value.context !== undefined) properties[ids.context!] = { rich_text: captureRichText(value.context) };
      if (value.filePaths !== undefined) properties[ids.files!] = { rich_text: captureRichText(value.filePaths.join("\n")) };
      if (value.sourceUrl !== undefined) properties[ids.sourceUrl!] = { url: value.sourceUrl };
      if (value.tags !== undefined) properties[ids.tags!] = { multi_select: value.tags.map((name) => ({ id: option("tags", name) })) };
      const body: Create = { parent: { type: "data_source_id", data_source_id: schema.dataSourceId }, properties };
      payloadLimit(body);
      const response = await mutate(budget, "POST", "/v1/pages", () => client.pages.create(body));
      const parsed = z.object({ object: z.literal("page"), id: z.uuid(), url: z.url(), parent: z.object({ type: z.literal("data_source_id"), data_source_id: z.string() }) }).safeParse(response);
      if (!parsed.success || canonicalNotionId(parsed.data.parent.data_source_id) !== schema.dataSourceId) throw new DomainError("WRITE_OUTCOME_UNKNOWN");
      const created = Object.freeze({ id: parsed.data.id.toLowerCase(), url: parsed.data.url });
      const pages = createdPages.get(budget) ?? new Set<string>(); pages.add(created.id); createdPages.set(budget, pages);
      return created;
    },
    async append(page, blocks, budget) {
      if (!createdPages.get(budget)?.has(page.id)) throw new DomainError("FORBIDDEN");
      if (!blocks.length || blocks.length > 100) throw new DomainError("VALIDATION_ERROR");
      const children = blocks.map(captureBlockPayload);
      payloadLimit({ children });
      const response = await mutate(budget, "PATCH", "/v1/blocks/" + page.id + "/children", () => client.blocks.children.append({ block_id: page.id, children }));
      const parsed = z.object({ object: z.literal("list"), results: z.array(z.object({ object: z.literal("block"), id: z.uuid() })) }).safeParse(response);
      if (!parsed.success || parsed.data.results.length !== blocks.length || new Set(parsed.data.results.map((item) => item.id)).size !== blocks.length) throw new DomainError("WRITE_OUTCOME_UNKNOWN");
    },
  } satisfies CaptureWriter);
}
