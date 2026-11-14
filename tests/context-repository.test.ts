import { describe, expect, it } from "vitest";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { createProjectContextService, createRequestBudget } from "../src/services/project-context.ts";
import { loadConfig } from "../src/config/environment.ts";
import { createContextFixtureApi, knowledge, knowledgeRecord, subproject } from "./fixtures/project-context.ts";
import { project } from "./fixtures/projects.ts";
import { validEnvironment, FAKE_NOTION_TOKEN } from "./fixtures/environment.ts";

async function setup(change?: (api: ReturnType<typeof createContextFixtureApi>) => void, wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) {
  const api = createContextFixtureApi();
  change?.(api);
  const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: wrap ? wrap(api.fetch) : api.fetch });
  const schemas = await createNotionSchemaIntegration(config, client).initialize();
  return { api, repo: client.createContextRepository(schemas) };
}
describe("Notion project context repository contract", () => {
  it("reads project, subproject and knowledge through the real SDK using validated property IDs", async () => {
    const { api, repo } = await setup();
    const result = await createProjectContextService(repo).get({ projectId: project.id, subprojectId: subproject.id, recentLimit: 1 });
    expect(result.project).toEqual(project);
    expect(result.subprojects).toEqual([subproject]);
    expect(result.recentKnowledge).toEqual([knowledge]);
    expect(result.setupRunbooks).toEqual([knowledge]);
    expect(result.needsReview).toEqual([knowledge]);
    expect(result.requestBudget.usedRequests).toBe(7);
    const calls = api.requests.filter((request) => request.method === "POST");
    expect(calls).toHaveLength(5);
    const bodies = await Promise.all(calls.map((request) => request.clone().json()));
    expect(bodies[0]).toMatchObject({ page_size: 100, filter: { property: "s_project", relation: { contains: project.id } } });
    for (const body of bodies.slice(1)) {
      expect(body.filter.and).toEqual(expect.arrayContaining([
        { property: "k_project", relation: { contains: project.id } }, { property: "k_subproject", relation: { contains: subproject.id } },
      ]));
      expect(body.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
    }
    expect(bodies[2].filter.and).toContainEqual({ property: "k_type", select: { equals: "Setup / Runbook" } });
    expect(bodies[3].filter.and).toContainEqual({ property: "k_verify", select: { equals: "Needs Review" } });
    for (const request of calls) expect(request.url).toMatch(/\/query$/);
    for (const request of api.requests) expect(["GET", "POST"]).toContain(request.method);
    expect(JSON.stringify(result)).not.toMatch(/created_by|properties|data_source_id/);
  });
  it("maps missing or wrong-source projects safely", async () => {
    const { repo } = await setup();
    await expect(repo.getProject(knowledge.id, createRequestBudget())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.getProject(subproject.id, createRequestBudget())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects archived projects and inconsistent pagination", async () => {
    const archived = await setup(undefined, (fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).includes("/pages/")) return Response.json({ ...await response.json() as object, archived: true });
      return response;
    });
    await expect(archived.repo.getProject(project.id, createRequestBudget())).rejects.toMatchObject({ code: "NOT_FOUND" });
    const malformed = await setup(undefined, (fetch) => async (input, init) => {
      if (String(input).endsWith("/query")) return Response.json({ object: "list", results: [], has_more: true, next_cursor: null });
      return fetch(input, init);
    });
    await expect(malformed.repo.scanKnowledge({ projectId: project.id, limit: 100 }, createRequestBudget())).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it("rejects a subproject belonging to another project", async () => {
    const { repo } = await setup((api) => { api.children[0]!.properties.Project.relation = [{ id: knowledge.id }]; });
    await expect(createProjectContextService(repo).get({ projectId: project.id, subprojectId: subproject.id })).rejects.toMatchObject({ code: "INVALID_RELATION" });
  });
  it("paginates truncated Project relations before deciding membership", async () => {
    let propertyReads = 0;
    const { repo } = await setup((api) => {
      api.children[0]!.properties.Project.has_more = true;
      api.children[0]!.properties.Project.relation = [{ id: knowledge.id }];
    }, (fetch) => async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/properties/")) {
        propertyReads++;
        expect(init?.method ?? "GET").toBe("GET");
        expect(url.searchParams.get("page_size")).toBe("100");
        const second = url.searchParams.get("start_cursor") === "next";
        return Response.json({ object: "list", results: [{ object: "property_item", type: "relation", relation: { id: second ? project.id : knowledge.id } }], has_more: !second, next_cursor: second ? null : "next" });
      }
      return fetch(input, init);
    });
    const budget = createRequestBudget(3);
    expect((await repo.getSubproject(subproject.id, budget)).projectIds).toEqual([knowledge.id, project.id]);
    expect(propertyReads).toBe(2);
    expect(budget.used).toBe(3);
    await expect(repo.getSubproject(subproject.id, createRequestBudget(1))).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
  });
  it("charges retries to the shared budget and never sends an over-budget attempt", async () => {
    let failures = 0;
    const { repo } = await setup(undefined, (fetch) => async (input, init) => {
      if (String(input).includes("/pages/")) { failures++; return Response.json({ code: "service_unavailable", message: "private " + FAKE_NOTION_TOKEN }, { status: 503, headers: { "retry-after": "0" } }); }
      return fetch(input, init);
    });
    const budget = createRequestBudget(2);
    await expect(repo.getProject(project.id, budget)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    expect(failures).toBe(2);
    expect(budget.used).toBe(2);
  });
  it("fails safely on malformed knowledge property payloads", async () => {
    const { repo } = await setup((api) => { Object.assign(api.entries[0]!.properties.Type, { select: { name: "Invented property value" } }); });
    await expect(repo.listKnowledge({ projectId: project.id, limit: 1 }, createRequestBudget())).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it("maps renamed response properties by ID and selects independent newest-first lists", async () => {
    const { repo } = await setup((api) => {
      api.entries.push(knowledgeRecord({ ...knowledge, id: "30000000-0000-4000-8000-000000000002", lastUpdated: "2026-11-02T00:00:00Z", type: "Reference", verification: "Verified" }));
      const properties = api.entries[0]!.properties;
      Object.assign(properties, { Renamed: properties.Name });
      Reflect.deleteProperty(properties, "Name");
    });
    const result = await createProjectContextService(repo).get({ projectId: project.id, recentLimit: 1 });
    expect(result.recentKnowledge[0]?.type).toBe("Reference");
    expect(result.setupRunbooks).toEqual([knowledge]);
    expect(result.needsReview).toEqual([knowledge]);
    expect(result.knowledgeCounts.total).toBe(2);
    expect(result.scan.recentKnowledge.reason).toBe("result_limit");
  });
  it("keeps concurrent requests on the same SDK client within separate budgets", async () => {
    const { repo } = await setup();
    const small = createRequestBudget(0);
    const large = createRequestBudget(2);
    const [first, second] = await Promise.allSettled([repo.getProject(project.id, small), repo.getProject(project.id, large)]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect(small.used).toBe(0);
    expect(large.used).toBe(1);
  });
});
