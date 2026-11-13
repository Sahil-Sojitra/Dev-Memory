import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { validEnvironment } from "./fixtures/environment.ts";
import { createFixtureApi, sourceIds } from "./fixtures/notion.ts";
import { project, projectRecord } from "./fixtures/projects.ts";

async function setup(response: unknown = { object: "list", results: [projectRecord()], has_more: false, next_cursor: null }, status = 200) {
  const metadata = createFixtureApi();
  const requests: Request[] = [];
  const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      requests.push(request);
      return Response.json(response, { status });
    }
    return metadata.fetch(input, init);
  } });
  const schemas = await createNotionSchemaIntegration(config, client).initialize();
  return { repository: client.createProjectRepository(schemas.projects), requests };
}

describe("Notion project repository", () => {
  it("maps only application fields using validated property IDs and API version", async () => {
    const record = projectRecord();
    record.properties.RenamedAtResponse = record.properties.Name!;
    delete record.properties.Name;
    const { repository, requests } = await setup({ object: "list", results: [record], has_more: false, next_cursor: null });
    expect(await repository.list({ limit: 50 })).toEqual({ projects: [project], hasMore: false, nextCursor: null });
    expect(requests[0]?.url).toBe("https://api.notion.com/v1/data_sources/" + sourceIds.projects + "/query");
    expect(requests[0]?.headers.get("notion-version")).toBe("2025-09-03");
    expect(requests[0]?.redirect).toBe("error");
    expect(await requests[0]!.json()).toEqual({ page_size: 50, sorts: [{ timestamp: "created_time", direction: "ascending" }] });
  });
  it("joins rich text fragments without exposing annotations or vendor fields", async () => {
    const record = projectRecord();
    record.properties.Name!.title = [{ plain_text: "Dev", annotations: { bold: true } }, { plain_text: "Memory" }];
    record.properties.Description!.rich_text = [{ plain_text: "Developer " }, { plain_text: "memory" }];
    const { repository } = await setup({ object: "list", results: [record], has_more: false, next_cursor: null });
    expect((await repository.list({ limit: 1 })).projects).toEqual([project]);
  });
  it.each(["absent", "empty"])("handles %s optional fields", async (mode) => {
    const record = projectRecord();
    if (mode === "absent") {
      delete record.properties.Description;
      delete record.properties["Repository URL"];
      delete record.properties.Status;
    } else {
      record.properties.Description!.rich_text = [];
      record.properties["Repository URL"]!.url = null;
      record.properties.Status!.select = null;
    }
    const { repository } = await setup({ object: "list", results: [record], has_more: false, next_cursor: null });
    expect((await repository.list({ limit: 1 })).projects[0]).toEqual({ id: project.id, name: project.name, url: project.url, primaryStack: project.primaryStack });
  });
  it("pushes exact status and opaque cursor upstream in one request", async () => {
    const { repository, requests } = await setup({ object: "list", results: [projectRecord()], has_more: true, next_cursor: "next:opaque" });
    expect(await repository.list({ status: "Active", limit: 1, cursor: "previous:opaque" })).toMatchObject({ hasMore: true, nextCursor: "next:opaque" });
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({ page_size: 1, start_cursor: "previous:opaque", filter: { property: "p_status", select: { equals: "Active" } } });
  });
  it.each([
    [401, "unauthorized", "UNAUTHORIZED"], [403, "restricted_resource", "FORBIDDEN"], [404, "object_not_found", "NOT_FOUND"],
    [429, "rate_limited", "RATE_LIMITED"], [504, "gateway_timeout", "TIMEOUT"], [500, "internal_server_error", "DEPENDENCY_UNAVAILABLE"],
  ] as const)("safely maps API status %s", async (status, code, expected) => {
    const { repository } = await setup({ object: "error", status, code, message: "synthetic vendor secret" }, status);
    await expect(repository.list({ limit: 1 })).rejects.toMatchObject({ code: expected, database: "projects" });
    try { await repository.list({ limit: 1 }); } catch (error) { expect(String(error)).not.toContain("synthetic vendor secret"); }
  });
  it.each(["wrong parent", "partial page", "wrong status", "wrong property", "missing name", "malformed description", "malformed repository", "malformed status"])("rejects invalid records: %s", async (mode) => {
    const record = projectRecord();
    if (mode === "wrong parent") record.parent.data_source_id = sourceIds.knowledge;
    if (mode === "partial page") record.object = "block";
    if (mode === "wrong status") record.properties.Status!.select = { name: "Unknown" };
    if (mode === "wrong property") record.properties.Name!.type = "rich_text";
    if (mode === "missing name") delete record.properties.Name;
    if (mode === "malformed description") delete record.properties.Description!.rich_text;
    if (mode === "malformed repository") delete record.properties["Repository URL"]!.url;
    if (mode === "malformed status") delete record.properties.Status!.select;
    const { repository } = await setup({ object: "list", results: [record], has_more: false, next_cursor: null });
    await expect(repository.list({ limit: 1 })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it.each([
    { object: "list", results: [], has_more: true, next_cursor: null },
    { object: "list", results: [], has_more: false, next_cursor: "unexpected" },
    { object: "list", results: [], has_more: true, next_cursor: "same" },
    { object: "list", results: [projectRecord(), projectRecord()], has_more: false, next_cursor: null },
  ])("rejects inconsistent or oversized pages", async (response) => {
    const { repository } = await setup(response);
    await expect(repository.list({ limit: 1, cursor: "same" })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
});
