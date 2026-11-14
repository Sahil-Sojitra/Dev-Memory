import type { Client } from "@notionhq/client";
import * as z from "zod";
import { DomainError, SchemaDriftError } from "../../domain/errors.ts";
import type { ValidatedDatabase, ApprovedPropertyName } from "../../domain/notion-schema.ts";
import type { ListProjectsInput, Project, ProjectRepository } from "../../domain/projects.ts";
import { NOTION_SCHEMA } from "../../domain/schema-map.ts";

const text = z.array(z.object({ plain_text: z.string() }));
const pageSchema = z.object({
  object: z.literal("page"), id: z.uuid(), url: z.url(),
  parent: z.object({ type: z.literal("data_source_id"), data_source_id: z.string() }),
  properties: z.record(z.string(), z.object({ id: z.string(), type: z.string() }).passthrough()),
});
const querySchema = z.object({
  object: z.literal("list"), results: z.array(z.unknown()).max(100),
  has_more: z.boolean(), next_cursor: z.string().min(1).nullable(),
});

function invalid(property?: ApprovedPropertyName): never {
  throw new SchemaDriftError([{ database: "projects", reason: "INVALID_METADATA", ...(property ? { property } : {}) }]);
}

export function mapProject(raw: unknown, schema: ValidatedDatabase): Project {
  const parsed = pageSchema.safeParse(raw);
  if (!parsed.success) return invalid();
  const page = parsed.data;
  if (page.parent.data_source_id.replaceAll("-", "").toLowerCase() !== schema.dataSourceId.replaceAll("-", "").toLowerCase()) return invalid();
  function field(key: string, optional = false): Record<string, unknown> | undefined {
    const mapped = schema.properties[key];
    if (!mapped) return invalid();
    const values = Object.values(page.properties).filter((property) => property.id === mapped.id);
    if (optional && values.length === 0) return undefined;
    const value = values[0];
    if (values.length !== 1 || !value || value.type !== mapped.type) return invalid(mapped.name);
    return value;
  }
  const title = text.safeParse(field("name")?.title);
  const stack = z.array(z.object({ name: z.enum(NOTION_SCHEMA.projects.primaryStack.options) })).safeParse(field("primaryStack")?.multi_select);
  if (!title.success) return invalid("Name");
  if (!stack.success) return invalid("Primary Stack");
  const descriptionField = field("description", true);
  const repositoryField = field("repositoryUrl", true);
  const statusField = field("status", true);
  const description = text.safeParse(descriptionField === undefined ? [] : descriptionField.rich_text);
  const repositoryUrl = z.url().nullable().safeParse(repositoryField === undefined ? null : repositoryField.url);
  const status = z.object({ name: z.enum(NOTION_SCHEMA.projects.status.options) }).nullable().safeParse(statusField === undefined ? null : statusField.select);
  if (!description.success) return invalid("Description");
  if (!repositoryUrl.success) return invalid("Repository URL");
  if (!status.success) return invalid("Status");
  const descriptionText = description.data.map((part) => part.plain_text).join("");
  return Object.freeze({
    id: page.id, name: title.data.map((part) => part.plain_text).join(""), url: page.url,
    ...(descriptionText ? { description: descriptionText } : {}),
    ...(repositoryUrl.data ? { repositoryUrl: repositoryUrl.data } : {}),
    ...(status.data ? { status: status.data.name } : {}),
    primaryStack: Object.freeze(stack.data.map((option) => option.name)),
  });
}

// SDK-specific types remain inside this adapter. One API request per bounded page.
export function createNotionProjectRepository(
  client: Client,
  schema: ValidatedDatabase,
  mapError: (error: unknown) => DomainError,
): ProjectRepository {
  return Object.freeze({
    async list(input: Omit<ListProjectsInput, "nameContains">) {
      try {
        const statusProperty = schema.properties.status;
        if (!statusProperty) return invalid();
        const filter = input.status === undefined ? undefined : { property: statusProperty.id, select: { equals: input.status } };
        const raw = await client.dataSources.query({
          data_source_id: schema.dataSourceId, page_size: input.limit,
          ...(input.cursor !== undefined ? { start_cursor: input.cursor } : {}),
          ...(filter ? { filter } : {}),
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
        });
        const result = querySchema.safeParse(raw);
        if (!result.success) return invalid();
        const response = result.data;
        if (response.results.length > input.limit || response.has_more !== (response.next_cursor !== null)
          || (response.has_more && response.next_cursor === input.cursor)) return invalid();
        return Object.freeze({
          projects: Object.freeze(response.results.map((page) => mapProject(page, schema))),
          hasMore: response.has_more, nextCursor: response.next_cursor,
        });
      } catch (error) {
        throw mapError(error);
      }
    },
  });
}
