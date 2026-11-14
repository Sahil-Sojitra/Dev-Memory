import type { Client } from "@notionhq/client";
import * as z from "zod";
import type { SearchRepository, SearchCandidate } from "../../domain/search-knowledge.ts";
import type { ValidatedDatabase } from "../../domain/notion-schema.ts";
import type { RequestBudget } from "../../domain/project-context.ts";
import { DomainError, SchemaDriftError } from "../../domain/errors.ts";
import { mapKnowledge } from "./project-context.ts";

type Filter = NonNullable<Parameters<Client["dataSources"]["query"]>[0]["filter"]>;
function invalid(): never { throw new SchemaDriftError([{ database: "knowledge", reason: "INVALID_METADATA" }]); }
export function createNotionSearchRepository(client: Client, schema: ValidatedDatabase,
  mapError: (error: unknown) => DomainError,
  withBudget: <T>(budget: RequestBudget, operation: () => Promise<T>) => Promise<T>,
): SearchRepository {
  function property(key: string): string { const id = schema.properties[key]?.id; if (!id) return invalid(); return id; }
  const repository: SearchRepository = { async list(input, limit, cursor, budget) {
    try {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DomainError("VALIDATION_ERROR");
      const and: Extract<Filter, { and: unknown }>["and"] = [];
      if (input.projectId) and.push({ property: property("project"), relation: { contains: input.projectId } });
      if (input.subprojectId) and.push({ property: property("subproject"), relation: { contains: input.subprojectId } });
      if (input.type) and.push({ or: input.type.map((value) => ({ property: property("type"), select: { equals: value } })) });
      if (input.verification) and.push({ or: input.verification.map((value) => ({ property: property("verification"), select: { equals: value } })) });
      for (const tag of input.tags ?? []) and.push({ property: property("tags"), multi_select: { contains: tag } });
      // Keywords intentionally stay out of this filter: metadata-only filtering
      // would discard body-only matches before auto depth could examine them.
      const raw = await withBudget(budget, () => client.dataSources.query({ data_source_id: schema.dataSourceId, page_size: limit,
        ...(cursor ? { start_cursor: cursor } : {}), ...(and.length ? { filter: { and } } : {}),
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      }));
      const parsed = z.object({ object: z.literal("list"), results: z.array(z.unknown()).max(50), has_more: z.boolean(), next_cursor: z.string().min(1).nullable() }).safeParse(raw);
      if (!parsed.success || parsed.data.results.length > limit || parsed.data.has_more !== (parsed.data.next_cursor !== null) || (parsed.data.has_more && parsed.data.next_cursor === cursor)) return invalid();
      const items: SearchCandidate[] = parsed.data.results.map((record) => {
        const entry = mapKnowledge(record, schema);
        const page = z.object({ properties: z.record(z.string(), z.object({ id: z.string(), type: z.string() }).passthrough()) }).safeParse(record);
        if (!page.success) return invalid();
        const properties = page.data.properties;
        function relation(key: string) {
          const fields = Object.values(properties).filter((field) => field.id === property(key));
          if (fields.length !== 1 || fields[0]?.type !== "relation") return invalid();
          const field = z.object({ relation: z.array(z.object({ id: z.uuid() })).max(1000), has_more: z.boolean().optional() }).safeParse(fields[0]);
          if (!field.success) return invalid();
          return { ids: Object.freeze([...new Set(field.data.relation.map((item) => item.id.toLowerCase()))]), truncated: field.data.has_more === true };
        }
        const project = relation("project"), subproject = relation("subproject");
        return Object.freeze({ ...entry, projectIds: project.ids, subprojectIds: subproject.ids, relationsTruncated: project.truncated || subproject.truncated });
      });
      return Object.freeze({ items: Object.freeze(items), hasMore: parsed.data.has_more, nextCursor: parsed.data.next_cursor });
    } catch (error) { throw mapError(error); }
  } };
  return Object.freeze(repository);
}
