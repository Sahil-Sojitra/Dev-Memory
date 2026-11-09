import { Client, isHTTPResponseError, isNotionClientError } from "@notionhq/client";
import * as z from "zod";
import type { AppConfig } from "../../config/environment.ts";
import { DomainError, NotionIntegrationError, SchemaDriftError } from "../../domain/errors.ts";
import type { ErrorCode } from "../../domain/errors.ts";
import type { ApprovedPropertyName, DatabaseKey, NotionSchemaReader, PropertyMetadata } from "../../domain/notion-schema.ts";
import { NOTION_SCHEMA } from "../../domain/schema-map.ts";

export const NOTION_REQUEST_TIMEOUT_MS = 10_000;
type SdkFetch = NonNullable<NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"]>;

const databaseResponse = z.object({
  object: z.literal("database"), id: z.string(),
  data_sources: z.array(z.object({ id: z.string() })),
});
const dataSourceResponse = z.object({
  object: z.literal("data_source"), id: z.string(),
  parent: z.object({ type: z.literal("database_id"), database_id: z.string() }),
  properties: z.record(z.string(), z.unknown()),
});
const propertyResponse = z.object({ id: z.string().min(1), type: z.string().min(1) });
const optionsResponse = z.object({ options: z.array(z.object({ name: z.string() })) });
const relationResponse = z.object({ database_id: z.string().optional(), data_source_id: z.string().optional() });

function invalidMetadata(database: DatabaseKey, property?: ApprovedPropertyName): never {
  throw new SchemaDriftError([{ database, ...(property ? { property } : {}), reason: "INVALID_METADATA" }]);
}

function mapClientError(error: unknown, database: DatabaseKey): DomainError {
  if (error instanceof DomainError) return error;
  let code: ErrorCode = "DEPENDENCY_UNAVAILABLE";
  if (isHTTPResponseError(error)) {
    if (error.status === 401) code = "UNAUTHORIZED";
    else if (error.status === 403) code = "FORBIDDEN";
    else if (error.status === 404) code = "NOT_FOUND";
    else if (error.status === 429) code = "RATE_LIMITED";
    else if (error.status === 504) code = "TIMEOUT";
  }
  if (isNotionClientError(error)) {
    switch (error.code) {
      case "unauthorized": code = "UNAUTHORIZED"; break;
      case "restricted_resource": code = "FORBIDDEN"; break;
      case "object_not_found": code = "NOT_FOUND"; break;
      case "rate_limited": code = "RATE_LIMITED"; break;
      case "validation_error":
      case "invalid_json":
      case "invalid_request":
      case "invalid_request_url":
      case "notionhq_client_invalid_path_parameter": code = "VALIDATION_ERROR"; break;
      case "conflict_error": code = "CONFLICT"; break;
      case "notionhq_client_request_timeout":
      case "gateway_timeout": code = "TIMEOUT"; break;
      default: break;
    }
  }
  // Never retain the SDK error, its cause, response body, message or headers.
  return new NotionIntegrationError(code, database);
}

export interface NotionReaderOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export function createNotionSchemaReader(config: AppConfig["notion"], options: NotionReaderOptions = {}): NotionSchemaReader {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  // Defense in depth: this integration has no write capability, even by accident.
  const readOnlyFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" || url.origin !== "https://api.notion.com"
      || !/^\/v1\/(databases|data_sources)\/[0-9a-f-]+$/i.test(url.pathname)
      || url.search || url.hash) {
      throw new DomainError("FORBIDDEN");
    }
    return fetchImplementation(input, { ...init, redirect: "error" });
  };
  // Adapt only the JSON metadata response surface. No SDK stream types escape.
  const sdkFetch: SdkFetch = async (url, init) => {
    const response = await readOnlyFetch(url, init);
    return { ok: response.ok, status: response.status, headers: response.headers, text: () => response.text() };
  };
  // One client per application instance; every metadata read reuses it.
  const client = new Client({
    auth: config.apiToken, notionVersion: config.apiVersion,
    timeoutMs: NOTION_REQUEST_TIMEOUT_MS,
    retry: { maxRetries: 2, initialRetryDelayMs: 100, maxRetryDelayMs: 500 },
    fetch: sdkFetch,
    logger: () => { /* SDK payload logging is deliberately disabled. */ },
  });

  return Object.freeze({
    async retrieveDatabase(database: DatabaseKey, id: string) {
      try {
        const parsed = databaseResponse.safeParse(await client.databases.retrieve({ database_id: id }));
        if (!parsed.success) return invalidMetadata(database);
        return Object.freeze({ id: parsed.data.id, dataSourceIds: Object.freeze(parsed.data.data_sources.map((source) => source.id)) });
      } catch (error) {
        throw mapClientError(error, database);
      }
    },
    async retrieveDataSource(database: DatabaseKey, id: string) {
      try {
        const parsed = dataSourceResponse.safeParse(await client.dataSources.retrieve({ data_source_id: id }));
        if (!parsed.success) return invalidMetadata(database);
        const properties: Record<string, PropertyMetadata> = Object.create(null) as Record<string, PropertyMetadata>;
        for (const [name, raw] of Object.entries(parsed.data.properties)) {
          const safeName = Object.values(NOTION_SCHEMA[database]).find((property) => property.name === name)?.name;
          const base = propertyResponse.safeParse(raw);
          if (!base.success) return invalidMetadata(database, safeName);
          const details = raw as Record<string, unknown>;
          const mapped: PropertyMetadata = { id: base.data.id, type: base.data.type };
          if (base.data.type === "select" || base.data.type === "multi_select") {
            const choices = optionsResponse.safeParse(details[base.data.type]);
            if (!choices.success) return invalidMetadata(database, safeName);
            properties[name] = Object.freeze({ ...mapped, options: Object.freeze(choices.data.options.map((choice) => choice.name)) });
          } else if (base.data.type === "relation") {
            const relation = relationResponse.safeParse(details.relation);
            if (!relation.success) return invalidMetadata(database, safeName);
            properties[name] = Object.freeze({
              ...mapped,
              relation: Object.freeze({
                ...(relation.data.database_id !== undefined ? { databaseId: relation.data.database_id } : {}),
                ...(relation.data.data_source_id !== undefined ? { dataSourceId: relation.data.data_source_id } : {}),
              }),
            });
          } else {
            properties[name] = Object.freeze(mapped);
          }
        }
        return Object.freeze({ id: parsed.data.id, databaseId: parsed.data.parent.database_id, properties: Object.freeze(properties) });
      } catch (error) {
        throw mapClientError(error, database);
      }
    },
  });
}
