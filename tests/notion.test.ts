import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionSchemaReader, NOTION_REQUEST_TIMEOUT_MS } from "../src/integrations/notion/client.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { DATABASE_KEYS } from "../src/domain/notion-schema.ts";
import type { ExpectedProperty } from "../src/domain/notion-schema.ts";
import { NOTION_SCHEMA } from "../src/domain/schema-map.ts";
import { DomainError, mapError, SchemaDriftError } from "../src/domain/errors.ts";
import { initializeApplication, runApplication } from "../src/app.ts";
import { FAKE_NOTION_TOKEN, validEnvironment } from "./fixtures/environment.ts";
import { createFixtureApi, databaseIds, notionFixtures, sourceIds } from "./fixtures/notion.ts";

afterEach(() => { vi.useRealTimers(); });

function setup(fixtures = notionFixtures(), environment = validEnvironment) {
  const config = loadConfig(environment);
  const api = createFixtureApi(fixtures);
  const reader = createNotionSchemaReader(config.notion, { fetch: api.fetch });
  return { config, api, reader, integration: createNotionSchemaIntegration(config.notion, reader) };
}
const propertyCases = DATABASE_KEYS.flatMap((database) => {
  const properties: Readonly<Record<string, ExpectedProperty>> = NOTION_SCHEMA[database];
  return Object.values(properties).map((property) => ({ database, property }));
});
const choiceCases = propertyCases.filter(({ property }) => property.options);
const relationCases = propertyCases.filter(({ property }) => property.relation);

describe("Notion metadata client and lifecycle", () => {
  it("uses validated credentials, pinned API, application-owned results, and GET-only requests", async () => {
    const { integration, api } = setup();
    const result = await integration.initialize();
    expect(api.requests).toHaveLength(6);
    for (const request of api.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer " + FAKE_NOTION_TOKEN);
      expect(request.headers.get("notion-version")).toBe("2025-09-03");
    }
    for (const key of DATABASE_KEYS) {
      expect(result[key].databaseId).toBe(databaseIds[key]);
      expect(result[key].dataSourceId).toBe(sourceIds[key]);
      expect(result[key]).not.toHaveProperty("object");
      expect(result[key]).not.toHaveProperty("title");
    }
    expect(Object.keys(result.projects.properties)).toHaveLength(7);
    expect(Object.keys(result.subprojects.properties)).toHaveLength(6);
    expect(Object.keys(result.knowledge.properties)).toHaveLength(11);
    expect(Object.isFrozen(result.knowledge.properties.type)).toBe(true);
    expect(result.knowledge.properties.project?.relation).toEqual({
      database: "projects", databaseId: databaseIds.projects, dataSourceId: sourceIds.projects,
    });
  });

  it("deduplicates concurrent initialization and caches only successful validated results", async () => {
    const { integration, api } = setup();
    const [first, second] = await Promise.all([integration.initialize(), integration.initialize()]);
    expect(first).toBe(second);
    expect(await integration.initialize()).toBe(first);
    expect(api.requests).toHaveLength(6);
  });

  it("allows a retry after a failed resolution without keeping a partial cache", async () => {
    const { integration, api } = setup();
    api.fixtures.databases.projects.data_sources = [];
    await expect(integration.initialize()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    api.fixtures.databases.projects.data_sources = [{ id: sourceIds.projects, name: "Projects" }];
    await expect(integration.initialize()).resolves.toHaveProperty("projects.dataSourceId", sourceIds.projects);
    expect(api.requests.filter((request) => request.url.includes("/data_sources/"))).toHaveLength(3);
  });

  it.each(DATABASE_KEYS)("rejects missing data sources for %s", async (key) => {
    const { integration, api } = setup();
    api.fixtures.databases[key].data_sources = [];
    await expect(integration.initialize()).rejects.toMatchObject({ issues: [{ database: key, reason: "DATA_SOURCE_COUNT" }] });
  });

  it.each(DATABASE_KEYS)("rejects ambiguous data sources for %s", async (key) => {
    const { integration, api } = setup();
    api.fixtures.databases[key].data_sources.push({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Unknown" });
    await expect(integration.initialize()).rejects.toMatchObject({ issues: [{ database: key, reason: "DATA_SOURCE_COUNT" }] });
  });

  it("rejects invalid, mismatched and duplicated resolved identities", async () => {
    for (const scenario of ["invalid", "hyphens", "database", "duplicate"] as const) {
      const { integration, api } = setup();
      if (scenario === "invalid") api.fixtures.databases.projects.data_sources[0]!.id = "invalid-id";
      if (scenario === "hyphens") api.fixtures.databases.projects.data_sources[0]!.id = "a-aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      if (scenario === "database") api.fixtures.databases.projects.id = databaseIds.knowledge;
      if (scenario === "duplicate") api.fixtures.databases.projects.data_sources[0]!.id = sourceIds.knowledge;
      await expect(integration.initialize()).rejects.toBeInstanceOf(SchemaDriftError);
    }
  });

  it("rejects expected-source mismatches without bypassing database resolution", async () => {
    const config = loadConfig({ ...validEnvironment, NOTION_PROJECTS_DATA_SOURCE_ID: sourceIds.knowledge });
    const api = createFixtureApi();
    const reader = createNotionSchemaReader(config.notion, { fetch: api.fetch });
    await expect(createNotionSchemaIntegration(config.notion, reader).initialize()).rejects.toMatchObject({
      issues: [{ database: "projects", reason: "UNEXPECTED_DATA_SOURCE" }],
    });
    expect(api.requests.some((request) => request.url.includes("/databases/"))).toBe(true);
  });

  it("rejects a wrong schema identity or parent database", async () => {
    for (const scenario of ["id", "parent"] as const) {
      const { integration, api } = setup();
      if (scenario === "id") api.fixtures.schemas.projects.id = sourceIds.knowledge;
      else api.fixtures.schemas.projects.parent.database_id = databaseIds.knowledge;
      await expect(integration.initialize()).rejects.toBeInstanceOf(SchemaDriftError);
    }
  });

  it("normalizes canonical, compact and uppercase metadata IDs consistently", async () => {
    const { integration, api } = setup();
    for (const key of DATABASE_KEYS) {
      api.fixtures.databases[key].id = databaseIds[key].replaceAll("-", "");
      api.fixtures.databases[key].data_sources[0]!.id = sourceIds[key].replaceAll("-", "").toUpperCase();
      api.fixtures.schemas[key].id = sourceIds[key].toUpperCase();
      api.fixtures.schemas[key].parent.database_id = databaseIds[key].replaceAll("-", "");
    }
    await expect(integration.initialize()).resolves.toHaveProperty("projects.dataSourceId", sourceIds.projects);
  });

  it.each([
    [401, "unauthorized", "UNAUTHORIZED"], [403, "restricted_resource", "FORBIDDEN"],
    [404, "object_not_found", "NOT_FOUND"], [400, "validation_error", "VALIDATION_ERROR"],
    [409, "conflict_error", "CONFLICT"], [429, "rate_limited", "RATE_LIMITED"],
    [503, "service_unavailable", "DEPENDENCY_UNAVAILABLE"], [504, "gateway_timeout", "TIMEOUT"],
  ])("maps HTTP %s safely for inaccessible/missing/failing metadata", async (status, code, expected) => {
    const fetch: typeof globalThis.fetch = async () => Response.json({
      object: "error", status, code, message: "private response " + FAKE_NOTION_TOKEN,
    }, { status, headers: { "retry-after": "0" } });
    const reader = createNotionSchemaReader(loadConfig(validEnvironment).notion, { fetch });
    try {
      await reader.retrieveDatabase("projects", databaseIds.projects);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: expected, database: "projects" });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(mapError(error, "fixture"))).not.toContain(FAKE_NOTION_TOKEN);
      expect(JSON.stringify(error)).not.toContain("private response");
    }
  });

  it("maps transport errors without retaining sensitive error objects", async () => {
    const reader = createNotionSchemaReader(loadConfig(validEnvironment).notion, { fetch: async () => { throw new Error("network secret " + FAKE_NOTION_TOKEN); } });
    await expect(reader.retrieveDatabase("knowledge", databaseIds.knowledge)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", database: "knowledge" });
  });

  it.each(DATABASE_KEYS)("fails safely when the resolved %s schema is inaccessible", async (database) => {
    const api = createFixtureApi();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/data_sources/" + sourceIds[database])) {
        return Response.json({ object: "error", status: 403, code: "restricted_resource", message: "private response" }, { status: 403 });
      }
      return api.fetch(input, init);
    };
    const config = loadConfig(validEnvironment);
    const reader = createNotionSchemaReader(config.notion, { fetch });
    await expect(createNotionSchemaIntegration(config.notion, reader).initialize()).rejects.toMatchObject({ code: "FORBIDDEN", database });
  });

  it("enforces the request timeout", async () => {
    vi.useFakeTimers();
    const reader = createNotionSchemaReader(loadConfig(validEnvironment).notion, { fetch: () => new Promise<Response>(() => {}) });
    const promise = reader.retrieveDatabase("projects", databaseIds.projects).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NOTION_REQUEST_TIMEOUT_MS + 1);
    expect(await promise).toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects partial/malformed metadata without echoing its payload", async () => {
    const reader = createNotionSchemaReader(loadConfig(validEnvironment).notion, { fetch: async () => Response.json({ object: "database", id: databaseIds.projects, private: FAKE_NOTION_TOKEN }) });
    await expect(reader.retrieveDatabase("projects", databaseIds.projects)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    await expect(reader.retrieveDataSource("projects", sourceIds.projects)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });

  it("exposes no write capabilities or SDK objects", () => {
    const { reader } = setup();
    expect(Object.keys(reader).sort()).toEqual(["retrieveDataSource", "retrieveDatabase"]);
    expect(Object.isFrozen(reader)).toBe(true);
  });

  it("blocks requests outside the metadata UUID routes before fetching", async () => {
    const { reader, api } = setup();
    await expect(reader.retrieveDatabase("projects", "pages")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(api.requests).toHaveLength(0);
  });

  it("maps malformed 404 error payloads safely by HTTP status", async () => {
    const reader = createNotionSchemaReader(loadConfig(validEnvironment).notion, { fetch: async () => new Response("private payload", { status: 404 }) });
    await expect(reader.retrieveDatabase("projects", databaseIds.projects)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("exact KAN-3 schema validation", () => {
  it.each(propertyCases)("maps $database.$property.name with its exact type", async ({ database, property }) => {
    const result = await setup().integration.initialize();
    expect(Object.values(result[database].properties).find((mapped) => mapped.name === property.name)?.type).toBe(property.type);
  });

  it.each(propertyCases)("detects missing $database.$property.name", async ({ database, property }) => {
    const { integration, api } = setup();
    delete api.fixtures.schemas[database].properties[property.name];
    await expect(integration.initialize()).rejects.toMatchObject({
      code: "SCHEMA_DRIFT", issues: [{ database, property: property.name, reason: "MISSING_PROPERTY" }],
    });
  });

  it.each(propertyCases)("detects changed type for $database.$property.name", async ({ database, property }) => {
    const { integration, api } = setup();
    api.fixtures.schemas[database].properties[property.name]!.type = "number";
    await expect(integration.initialize()).rejects.toMatchObject({
      issues: [{ database, property: property.name, reason: "WRONG_TYPE" }],
    });
  });

  it.each(choiceCases)("rejects unknown options on $database.$property.name", async ({ database, property }) => {
    const { integration, api } = setup();
    const live = api.fixtures.schemas[database].properties[property.name]!;
    const choices = property.type === "select" ? live.select : live.multi_select;
    choices!.options.push({ name: "unknown-private-option " + FAKE_NOTION_TOKEN });
    try {
      await integration.initialize();
      throw new Error("Expected drift");
    } catch (error) {
      expect(error).toMatchObject({ code: "SCHEMA_DRIFT", issues: [{ database, property: property.name, reason: "OPTIONS_CHANGED" }] });
      expect(JSON.stringify(mapError(error, "fixture"))).not.toContain("unknown-private-option");
      expect(JSON.stringify(mapError(error, "fixture"))).not.toContain(FAKE_NOTION_TOKEN);
    }
  });

  it.each(choiceCases)("rejects missing, renamed, duplicate or case-changed options on $database.$property.name", async ({ database, property }) => {
    for (const mutation of ["missing", "renamed", "duplicate", "case"] as const) {
      const { integration, api } = setup();
      const live = api.fixtures.schemas[database].properties[property.name]!;
      const choices = (property.type === "select" ? live.select : live.multi_select)!.options;
      if (mutation === "missing") choices.pop();
      if (mutation === "renamed") choices[0]!.name = "Unapproved";
      if (mutation === "duplicate") choices[1]!.name = choices[0]!.name;
      if (mutation === "case") choices[0]!.name = choices[0]!.name.toUpperCase();
      await expect(integration.initialize()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
    }
  });

  it("ignores option ordering and tolerates unmapped extra properties", async () => {
    const { integration, api } = setup();
    api.fixtures.schemas.projects.properties.Status!.select!.options.reverse();
    api.fixtures.schemas.projects.properties.Extra = { id: "extra", type: "number" };
    await expect(integration.initialize()).resolves.toHaveProperty("projects");
  });

  it.each(relationCases)("rejects changed database/data-source targets for $database.$property.name", async ({ database, property }) => {
    for (const target of ["database_id", "data_source_id"] as const) {
      const { integration, api } = setup();
      api.fixtures.schemas[database].properties[property.name]!.relation![target] = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await expect(integration.initialize()).rejects.toMatchObject({
        issues: [{ database, property: property.name, reason: "RELATION_TARGET" }],
      });
    }
  });

  it("can resolve a relation whose API representation contains only a data-source target", async () => {
    const { integration, api } = setup();
    delete api.fixtures.schemas.subprojects.properties.Project!.relation!.database_id;
    await expect(integration.initialize()).resolves.toHaveProperty("subprojects.properties.project.relation.databaseId", databaseIds.projects);
  });

  it("rejects a relation with no target", async () => {
    const { integration, api } = setup();
    api.fixtures.schemas.knowledge.properties.Project!.relation = {};
    await expect(integration.initialize()).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });

  it("identifies the approved property for malformed option metadata", async () => {
    const { integration, api } = setup();
    delete api.fixtures.schemas.knowledge.properties.Type!.select;
    await expect(integration.initialize()).rejects.toMatchObject({ issues: [{ database: "knowledge", property: "Type", reason: "INVALID_METADATA" }] });
  });

  it("preserves exact system-managed types and independently verified option strings", () => {
    expect(NOTION_SCHEMA.projects.created.type).toBe("created_time");
    expect(NOTION_SCHEMA.knowledge.lastUpdated.type).toBe("last_edited_time");
    expect(NOTION_SCHEMA.knowledge.type.options).toEqual(["Implementation", "Technical Decision", "Error & Fix", "Setup / Runbook", "Reference", "Learning"]);
    expect(NOTION_SCHEMA.knowledge.verification.options).toEqual(["Draft", "Hypothesis", "Verified", "Needs Review"]);
    expect(NOTION_SCHEMA.subprojects.type.options).toEqual(["Frontend", "Backend", "Mobile", "API / Service", "Infrastructure", "Feature", "Other"]);
    expect(NOTION_SCHEMA.projects.primaryStack.options).toEqual(["JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Python", "Django", "FastAPI", "MongoDB", "PostgreSQL", "React Native"]);
    expect(NOTION_SCHEMA.knowledge.tags.options).toEqual(["architecture", "frontend", "backend", "database", "deployment", "debugging", "auth", "performance", "testing"]);
  });
});

describe("startup schema gate", () => {
  it("blocks live verification safely when process configuration is absent", () => {
    const result = spawnSync(process.execPath, ["scripts/verify-notion.mjs"], {
      env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ status: "BLOCKED", invalidFields: expect.arrayContaining(["NOTION_API", "NOTION_PROJECTS_DATABASE_ID"]) });
  });
  it("initializes a reusable application context without tools, listeners or record operations", async () => {
    const { reader, api } = setup();
    const lines: string[] = [];
    const application = await initializeApplication(validEnvironment, { schemaReader: reader, destination: { write(line: string) { lines.push(line); } } });
    expect(await application.notion.initialize()).toBe(application.schemas);
    expect(api.requests).toHaveLength(6);
    expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    expect(lines.join("")).toContain("notion_schema_validated");
    expect(lines.join("")).not.toContain(FAKE_NOTION_TOKEN);
  });

  it("does not report readiness on drift and logs safe actionable database/property context", async () => {
    const { reader, api } = setup();
    delete api.fixtures.schemas.knowledge.properties.Type;
    const lines: string[] = [];
    expect(await runApplication(validEnvironment, { schemaReader: reader, destination: { write(line: string) { lines.push(line); } } })).toBe(1);
    const output = lines.join("");
    expect(output).not.toContain("application_ready");
    expect(output).toContain("SCHEMA_DRIFT");
    expect(output).toContain("knowledge");
    expect(output).toContain("Type");
    expect(output).not.toContain(FAKE_NOTION_TOKEN);
    expect(output).not.toContain("stack");
  });

  it("succeeds only after all schemas pass", async () => {
    const { reader } = setup();
    const lines: string[] = [];
    expect(await runApplication(validEnvironment, { schemaReader: reader, destination: { write(line: string) { lines.push(line); } } })).toBe(0);
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["notion_schema_validated", "application_ready"]);
  });
});
