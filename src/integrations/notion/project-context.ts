import type { Client } from "@notionhq/client";
import * as z from "zod";
import { DomainError, SchemaDriftError } from "../../domain/errors.ts";
import type { DatabaseKey, ValidatedDatabase, ValidatedSchema } from "../../domain/notion-schema.ts";
import { canonicalNotionId } from "../../domain/notion-schema.ts";
import type { ProjectContextRepository, RequestBudget, KnowledgeEntry, Subproject, KnowledgeQuery } from "../../domain/project-context.ts";
import { NOTION_SCHEMA } from "../../domain/schema-map.ts";
import { mapProject } from "./projects.ts";

const page = z.object({ object: z.literal("page"), id: z.uuid(), url: z.url(), archived: z.boolean().optional(), in_trash: z.boolean().optional(),
  parent: z.object({ type: z.literal("data_source_id"), data_source_id: z.string() }),
  properties: z.record(z.string(), z.object({ id: z.string(), type: z.string() }).passthrough()),
});
const text = z.array(z.object({ plain_text: z.string() }));
const query = z.object({ object: z.literal("list"), results: z.array(z.unknown()).max(100), has_more: z.boolean(), next_cursor: z.string().min(1).nullable() });
type QueryFilter = NonNullable<Parameters<Client["dataSources"]["query"]>[0]["filter"]>;
type PropertyFilter = Extract<QueryFilter, { property: string }>;
function invalid(database: DatabaseKey): never { throw new SchemaDriftError([{ database, reason: "INVALID_METADATA" }]); }

function fields(raw: unknown, schema: ValidatedDatabase, database: DatabaseKey) {
  const parsed = page.safeParse(raw);
  if (!parsed.success) return invalid(database);
  const value = parsed.data;
  if (canonicalNotionId(value.parent.data_source_id) !== schema.dataSourceId || value.archived || value.in_trash) throw new DomainError("NOT_FOUND");
  function field(key: string): Record<string, unknown> {
    const property = schema.properties[key];
    if (!property) return invalid(database);
    const found = Object.values(value.properties).filter((item) => item.id === property.id);
    if (found.length !== 1 || found[0]?.type !== property.type) return invalid(database);
    return found[0];
  }
  function rich(key: string): string {
    const property = field(key);
    const result = text.safeParse(property[String(property.type)]);
    if (!result.success) return invalid(database);
    return result.data.map((part) => part.plain_text).join("");
  }
  function select<const T extends readonly [string, ...string[]]>(key: string, options: T): T[number] | undefined {
    const result = z.object({ name: z.enum(options) }).nullable().safeParse(field(key).select);
    if (!result.success) return invalid(database);
    return result.data?.name;
  }
  return { value, field, rich, select };
}
function subproject(raw: unknown, schema: ValidatedDatabase): Subproject {
  const f = fields(raw, schema, "subprojects");
  const relation = f.field("project");
  // A truncated inline relation cannot prove non-membership. Fail closed rather
  // than returning INVALID_RELATION from incomplete data.
  if (relation.has_more === true) throw new DomainError("DEPENDENCY_UNAVAILABLE");
  const ids = z.array(z.object({ id: z.uuid() })).safeParse(relation.relation);
  if (!ids.success) return invalid("subprojects");
  const description = f.rich("description");
  const repositoryPath = f.rich("repositoryPath");
  const type = f.select("type", NOTION_SCHEMA.subprojects.type.options);
  const status = f.select("status", NOTION_SCHEMA.subprojects.status.options);
  return Object.freeze({ id: f.value.id.toLowerCase(), name: f.rich("name"), url: f.value.url,
    ...(description ? { description } : {}), ...(repositoryPath ? { repositoryPath } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}),
    projectIds: Object.freeze(ids.data.map((item) => item.id.toLowerCase())),
  });
}
function classification(raw: unknown, schema: ValidatedDatabase) {
  const f = fields(raw, schema, "knowledge");
  const type = f.select("type", NOTION_SCHEMA.knowledge.type.options);
  const verification = f.select("verification", NOTION_SCHEMA.knowledge.verification.options);
  return { f, item: Object.freeze({ id: f.value.id.toLowerCase(), ...(type ? { type } : {}), ...(verification ? { verification } : {}) }) };
}
export function mapKnowledge(raw: unknown, schema: ValidatedDatabase): KnowledgeEntry {
  const { f, item } = classification(raw, schema);
  const updated = z.iso.datetime({ offset: true }).safeParse(f.field("lastUpdated").last_edited_time);
  const tags = z.array(z.object({ name: z.enum(NOTION_SCHEMA.knowledge.tags.options) })).safeParse(f.field("tags").multi_select);
  const source = z.url().nullable().safeParse(f.field("sourceUrl").url);
  if (!updated.success || !tags.success || !source.success) return invalid("knowledge");
  const context = f.rich("context");
  const files = f.rich("files");
  return Object.freeze({ ...item, name: f.rich("name"), url: f.value.url, lastUpdated: updated.data,
    tags: Object.freeze(tags.data.map((tag) => tag.name)), ...(context ? { context } : {}), ...(files ? { files } : {}), ...(source.data ? { sourceUrl: source.data } : {}),
  });
}

export function createNotionContextRepository(client: Client, schemas: ValidatedSchema,
  mapError: (error: unknown, database: DatabaseKey) => DomainError,
  withBudget: <T>(budget: RequestBudget, operation: () => Promise<T>) => Promise<T>,
): ProjectContextRepository {
  async function retrieve(id: string, database: "projects" | "subprojects", budget: RequestBudget) {
    try {
      const raw = await withBudget(budget, () => client.pages.retrieve({ page_id: id }));
      const mapped = fields(raw, schemas[database], database);
      if (canonicalNotionId(mapped.value.id) !== id) return invalid(database);
      return raw;
    } catch (error) { throw mapError(error, database); }
  }
  async function read<T>(database: "subprojects" | "knowledge", limit: number, cursor: string | undefined,
    filter: QueryFilter, mapper: (raw: unknown, schema: ValidatedDatabase) => T | Promise<T>, budget: RequestBudget) {
    try {
      const raw = await withBudget(budget, () => client.dataSources.query({ data_source_id: schemas[database].dataSourceId, page_size: limit,
        ...(cursor ? { start_cursor: cursor } : {}), filter,
        sorts: [{ timestamp: database === "knowledge" ? "last_edited_time" : "created_time", direction: database === "knowledge" ? "descending" : "ascending" }],
      }));
      const parsed = query.safeParse(raw);
      if (!parsed.success) return invalid(database);
      const result = parsed.data;
      if (result.results.length > limit || result.has_more !== (result.next_cursor !== null) || (result.has_more && result.next_cursor === cursor)) return invalid(database);
      const items: T[] = [];
      for (const record of result.results) items.push(await mapper(record, schemas[database]));
      return Object.freeze({ items: Object.freeze(items), hasMore: result.has_more, nextCursor: result.next_cursor });
    } catch (error) { throw mapError(error, database); }
  }
  function property(database: "subprojects" | "knowledge", name: string): string {
    const mapped = schemas[database].properties[name];
    if (!mapped) return invalid(database);
    return mapped.id;
  }
  function filter(input: KnowledgeQuery) {
    const clauses: PropertyFilter[] = [
      { property: property("knowledge", "project"), relation: { contains: input.projectId } },
    ];
    if (input.subprojectId) clauses.push({ property: property("knowledge", "subproject"), relation: { contains: input.subprojectId } });
    if (input.category === "setup") clauses.push({ property: property("knowledge", "type"), select: { equals: "Setup / Runbook" } });
    if (input.category === "needsReview") clauses.push({ property: property("knowledge", "verification"), select: { equals: "Needs Review" } });
    return { and: clauses };
  }
  async function completeSubproject(raw: unknown, budget: RequestBudget): Promise<Subproject> {
    try {
      const f = fields(raw, schemas.subprojects, "subprojects");
      const relation = f.field("project");
      if (relation.has_more !== true) return subproject(raw, schemas.subprojects);
      const ids: { id: string }[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const response = await withBudget(budget, () => client.pages.properties.retrieve({
          page_id: f.value.id, property_id: property("subprojects", "project"), page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }));
        const parsed = query.safeParse(response);
        if (!parsed.success || parsed.data.has_more !== (parsed.data.next_cursor !== null)) return invalid("subprojects");
        for (const item of parsed.data.results) {
          const parsedItem = z.object({ object: z.literal("property_item"), type: z.literal("relation"), relation: z.object({ id: z.uuid() }) }).safeParse(item);
          if (!parsedItem.success) return invalid("subprojects");
          ids.push(parsedItem.data.relation);
        }
        if (!parsed.data.has_more) break;
        const next = parsed.data.next_cursor!;
        if (seen.has(next)) return invalid("subprojects");
        seen.add(next); cursor = next;
      }
      const key = Object.keys(f.value.properties).find((name) => f.value.properties[name]?.id === property("subprojects", "project"));
      if (!key) return invalid("subprojects");
      return subproject({ ...f.value, properties: { ...f.value.properties, [key]: { ...relation, relation: ids, has_more: false } } }, schemas.subprojects);
    } catch (error) { throw mapError(error, "subprojects"); }
  }
  return Object.freeze({
    async getProject(id, budget) { return mapProject(await retrieve(id, "projects", budget), schemas.projects); },
    async getSubproject(id, budget) { return completeSubproject(await retrieve(id, "subprojects", budget), budget); },
    listSubprojects(projectId, limit, cursor, budget) { return read("subprojects", limit, cursor, { property: property("subprojects", "project"), relation: { contains: projectId } }, (raw) => completeSubproject(raw, budget), budget); },
    listKnowledge(input, budget) { return read("knowledge", input.limit, input.cursor, filter(input), mapKnowledge, budget); },
    scanKnowledge(input, budget) { return read("knowledge", input.limit, input.cursor, filter(input), (raw, schema) => classification(raw, schema).item, budget); },
  } satisfies ProjectContextRepository);
}
