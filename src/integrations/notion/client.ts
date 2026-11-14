import { APIErrorCode, ClientErrorCode, Client, isHTTPResponseError, isNotionClientError } from "@notionhq/client";
import * as z from "zod";
import type { AppConfig } from "../../config/environment.ts";
import { DomainError, NotionIntegrationError, SchemaDriftError } from "../../domain/errors.ts";
import type { ErrorCode } from "../../domain/errors.ts";
import type { ApprovedPropertyName, DatabaseKey, NotionSchemaReader, PropertyMetadata } from "../../domain/notion-schema.ts";
import { NOTION_SCHEMA } from "../../domain/schema-map.ts";
import type { ValidatedDatabase } from "../../domain/notion-schema.ts";
import type { ProjectRepository } from "../../domain/projects.ts";
import { createNotionProjectRepository } from "./projects.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectContextRepository, RequestBudget } from "../../domain/project-context.ts";
import type { ValidatedSchema } from "../../domain/notion-schema.ts";
import { createNotionContextRepository } from "./project-context.ts";
import { cancelNotionBody, readNotionBody } from "./deadline.ts";

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
  readonly onMetadataFailure?: (failure: NotionMetadataFailure) => void;
}

export interface NotionMetadataFailure {
  readonly dependency: "notion";
  readonly operation: "retrieve_database" | "retrieve_data_source";
  readonly database: DatabaseKey;
  readonly code: ErrorCode;
  readonly category: "http_response" | "request_timeout" | "network" | "invalid_response" | "schema_validation" | "application_or_transport";
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
  readonly networkCode?: string;
}

const upstreamCodes = new Set<string>([...Object.values(APIErrorCode), ...Object.values(ClientErrorCode)]);
const networkCodes = new Set<string>([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function metadataFailure(error: unknown, database: DatabaseKey, operation: NotionMetadataFailure["operation"], mapped: DomainError): NotionMetadataFailure {
  let networkCode: string | undefined;
  let candidate: unknown = error;
  for (let depth = 0; depth < 3 && candidate instanceof Error; depth++) {
    const code = Object.getOwnPropertyDescriptor(candidate, "code")?.value as unknown;
    if (typeof code === "string" && networkCodes.has(code)) { networkCode = code; break; }
    candidate = Object.getOwnPropertyDescriptor(candidate, "cause")?.value as unknown;
  }
  const http = isHTTPResponseError(error);
  const upstreamCode = isNotionClientError(error) && upstreamCodes.has(error.code) ? error.code : undefined;
  return Object.freeze({
    dependency: "notion", operation, database, code: mapped.code,
    category: http ? "http_response" : upstreamCode === "notionhq_client_request_timeout" ? "request_timeout"
      : networkCode ? "network" : error instanceof SyntaxError ? "invalid_response"
        : error instanceof SchemaDriftError ? "schema_validation" : "application_or_transport",
    ...(http && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { upstreamStatus: error.status } : {}),
    ...(upstreamCode ? { upstreamCode } : {}), ...(networkCode ? { networkCode } : {}),
  });
}

export interface NotionClient extends NotionSchemaReader {
  createProjectRepository(schema: ValidatedDatabase): ProjectRepository;
  createContextRepository(schemas: ValidatedSchema): ProjectContextRepository;
}

export function createNotionClient(config: AppConfig["notion"], options: NotionReaderOptions = {}): NotionClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const projectSources = new Set<string>();
  const contextSources = new Set<string>();
  const requestBudgets = new AsyncLocalStorage<RequestBudget>();
  let contextEnabled = false;
  // Defense in depth: this integration has no write capability, even by accident.
  const readOnlyFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const metadataRead = method === "GET" && /^\/v1\/(databases|data_sources)\/[0-9a-f-]+$/i.test(url.pathname);
    const projectQuery = method === "POST" && [...projectSources].some((id) => url.pathname === "/v1/data_sources/" + id + "/query");
    const contextRead = contextEnabled && requestBudgets.getStore() !== undefined && method === "GET" && /^\/v1\/pages\/[0-9a-f-]+$/i.test(url.pathname);
    const relationRead = contextEnabled && requestBudgets.getStore() !== undefined && method === "GET"
      && /^\/v1\/pages\/[0-9a-f-]+\/properties\/[^/]+$/i.test(url.pathname)
      && [...url.searchParams.keys()].every((key) => key === "page_size" || key === "start_cursor")
      && url.searchParams.get("page_size") === "100";
    const contextQuery = requestBudgets.getStore() !== undefined && method === "POST" && [...contextSources].some((id) => url.pathname === "/v1/data_sources/" + id + "/query");
    if ((!metadataRead && !projectQuery && !contextRead && !contextQuery && !relationRead) || url.origin !== "https://api.notion.com"
      || (url.search && !relationRead) || url.hash) {
      throw new DomainError("FORBIDDEN");
    }
    const budget = requestBudgets.getStore();
    if (!budget) return fetchImplementation(input, { ...init, redirect: "error" });
    const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = upstreamSignal ? AbortSignal.any([budget.signal, upstreamSignal]) : budget.signal;
    return budget.run(async () => {
      budget.consume();
      const response = await fetchImplementation(input, { ...init, redirect: "error", signal });
      try { budget.assertActive(); }
      catch (error) { cancelNotionBody(response); throw error; }
      return response;
    });
  };
  // Adapt the JSON response surface. No SDK stream types escape.
  const sdkFetch: SdkFetch = async (url, init) => {
    const budget = requestBudgets.getStore();
    const response = await readOnlyFetch(url, init);
    return { ok: response.ok, status: response.status, headers: response.headers,
      text: () => budget ? readNotionBody(response, budget) : response.text(),
    };
  };
  // One client per application instance; metadata and project reads reuse it.
  const client = new Client({
    auth: config.apiToken, notionVersion: config.apiVersion,
    timeoutMs: NOTION_REQUEST_TIMEOUT_MS,
    retry: { maxRetries: 2, initialRetryDelayMs: 100, maxRetryDelayMs: 500 },
    fetch: sdkFetch,
    logger: () => { /* SDK payload logging is deliberately disabled. */ },
  });

  function metadataError(error: unknown, database: DatabaseKey, operation: NotionMetadataFailure["operation"]): DomainError {
    const mapped = mapClientError(error, database);
    // Diagnostic callbacks receive only projected constants/codes, never SDK
    // errors, request URLs, IDs, headers, messages, response bodies or causes.
    try { options.onMetadataFailure?.(metadataFailure(error, database, operation, mapped)); }
    catch { /* Diagnostics must not replace the original failure or affect retries. */ }
    return mapped;
  }

  return Object.freeze({
    createContextRepository(schemas: ValidatedSchema) {
      for (const key of ["projects", "subprojects", "knowledge"] as const) {
        if (schemas[key].databaseId !== config.databases[key]) throw new DomainError("FORBIDDEN");
      }
      contextEnabled = true;
      for (const schema of Object.values(schemas)) contextSources.add(schema.dataSourceId);
      // Wrap the whole SDK operation, including its otherwise non-abortable
      // retry sleeps. A sleeping SDK continuation cannot start another fetch
      // after expiry because every attempt rechecks the same budget.
      return createNotionContextRepository(client, schemas, mapClientError, (budget, operation) => requestBudgets.run(budget, () => budget.run(operation)));
    },
    createProjectRepository(schema: ValidatedDatabase) {
      if (schema.databaseId !== config.databases.projects) throw new DomainError("FORBIDDEN");
      projectSources.add(schema.dataSourceId);
      return createNotionProjectRepository(client, schema, (error) => mapClientError(error, "projects"));
    },
    async retrieveDatabase(database: DatabaseKey, id: string) {
      try {
        const parsed = databaseResponse.safeParse(await client.databases.retrieve({ database_id: id }));
        if (!parsed.success) return invalidMetadata(database);
        return Object.freeze({ id: parsed.data.id, dataSourceIds: Object.freeze(parsed.data.data_sources.map((source) => source.id)) });
      } catch (error) {
        throw metadataError(error, database, "retrieve_database");
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
        throw metadataError(error, database, "retrieve_data_source");
      }
    },
  });
}

// Backwards-compatible metadata reader entry; the application uses the shared client.
export function createNotionSchemaReader(config: AppConfig["notion"], options: NotionReaderOptions = {}): NotionSchemaReader {
  const client = createNotionClient(config, options);
  return Object.freeze({ retrieveDatabase: client.retrieveDatabase, retrieveDataSource: client.retrieveDataSource });
}
