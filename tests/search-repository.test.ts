import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { createSearchService } from "../src/services/search-knowledge.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { searchInputSchema } from "../src/domain/search-knowledge.ts";
import { validEnvironment } from "./fixtures/environment.ts";
import { candidate, createSearchFixtureApi, golden } from "./fixtures/search-knowledge.ts";
import { memoryContextRepository } from "./fixtures/project-context.ts";
import { memorySearch } from "./fixtures/search-knowledge.ts";
import { project } from "./fixtures/projects.ts";
import { subproject } from "./fixtures/project-context.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) {
  const api = createSearchFixtureApi(golden, new Map([[golden[5]!.id, "deploy node"]])); const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: wrap ? wrap(api.fetch) : api.fetch }); const schemas = await createNotionSchemaIntegration(config, client).initialize();
  const repository = client.createSearchRepository(schemas.knowledge); const scope = client.createContextRepository(schemas);
  const bodies = createKnowledgeEntryService(client.createKnowledgeEntryRepository(schemas.knowledge));
  return { api, repository, scope, bodies, service: createSearchService(repository, scope, bodies) };
}
describe("search repository via installed Notion SDK", () => {
  it("audit: counts exactly 40 actual fetches and prevents an SDK retry from becoming attempt 41", async () => {
    const api = createSearchFixtureApi(Array.from({ length: 201 }, (_, index) => candidate(index + 1, { name: "deploy" })));
    let operations = 0, blockAttempts = 0;
    const config = loadConfig(validEnvironment).notion;
    const client = createNotionClient(config, { fetch: async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (request.method === "POST" || path.startsWith("/v1/pages/") || path.startsWith("/v1/blocks/")) operations++;
      if (path.startsWith("/v1/blocks/") && ++blockAttempts === 18) {
        return Response.json({ object: "error", code: "rate_limited", message: "synthetic" }, { status: 429, headers: { "retry-after": "0" } });
      }
      return api.fetch(input, init);
    } });
    const schemas = await createNotionSchemaIntegration(config, client).initialize();
    const service = createSearchService(client.createSearchRepository(schemas.knowledge), client.createContextRepository(schemas), createKnowledgeEntryService(client.createKnowledgeEntryRepository(schemas.knowledge)));
    const result = await service.search({ query: "deploy" });
    expect(operations).toBe(40); expect(blockAttempts).toBe(18);
    expect(result.diagnostics).toMatchObject({ requestCount: 40, maxRequests: 40, truncated: true });
    expect(result.diagnostics.truncationReasons).toContain("request_budget");
  });
  it("audit: SDK-backed concurrent searches retain isolated 21-attempt counts", async () => {
    const f = await setup();
    const results = await Promise.all([f.service.search({ query: "deploy node" }), f.service.search({ query: "deploy node" })]);
    expect(results.map((result) => result.diagnostics.requestCount)).toEqual([21, 21]);
    const operations = f.api.requests.filter((request) => request.method === "POST" || /\/v1\/(?:pages|blocks)\//.test(new URL(request.url).pathname));
    expect(operations).toHaveLength(42);
    expect(results.every((result) => !result.diagnostics.cacheHit)).toBe(true);
  });
  it("audit: preserves request-budget diagnostics when incomplete relations cannot prove filter membership", async () => {
    let operations = 0, relationPages = 0;
    const f = await setup((fetch) => async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (request.method === "POST" || path.startsWith("/v1/pages/") || path.startsWith("/v1/blocks/")) operations++;
      if (path.endsWith("/properties/k_project")) {
        return Response.json({ object: "list", results: [{ object: "property_item", type: "relation", relation: { id: "10000000-0000-4000-8000-000000000099" } }], has_more: true, next_cursor: "audit:" + ++relationPages });
      }
      const response = await fetch(input, init);
      if (request.method !== "POST" && path !== "/v1/pages/" + golden[0]!.id) return response;
      type Page = { properties: { Project: { relation: { id: string }[]; has_more: boolean } } };
      if (request.method === "POST") {
        const body = await response.json() as { results: Page[]; has_more: boolean; next_cursor: string | null };
        // The server-side relation filter matched the complete Notion relation;
        // the inline preview omits that target and requires property pagination.
        body.results = [body.results[0]!]; body.has_more = false; body.next_cursor = null;
        body.results[0]!.properties.Project = { ...body.results[0]!.properties.Project, relation: [], has_more: true };
        return Response.json(body);
      }
      const body = await response.json() as Page;
      body.properties.Project = { ...body.properties.Project, relation: [], has_more: true };
      return Response.json(body);
    });
    const result = await f.service.search({ query: "deploy", projectId: project.id });
    expect(operations).toBe(40); expect(relationPages).toBe(37);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.diagnostics.truncationReasons).toContain("request_budget");
    // Missing membership in a partial relation is unknown, not proof of a change.
    expect(result.diagnostics.changedCandidates).toBe(0);
    expect(result.diagnostics).toMatchObject({ requestCount: 40, maxRequests: 40, relationTruncatedCandidates: 1,
      bodiesScanned: 1, bodiesTruncated: 1, bodyEvaluationComplete: false });
    expect(result.diagnostics.truncationReasons).toEqual(["body_truncated", "relation_limit", "request_budget"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ relationsTruncated: true, bodyTruncated: true, bodyTruncationReasons: ["request_budget"] });
  });
  it.each([
    { filter: { type: ["Error & Fix"] }, query: "deploy", expected: [golden[8]!.id] },
    { filter: { verification: ["Verified"] }, query: "deploy", expected: [golden[8]!.id] },
    { filter: { type: ["Error & Fix", "Reference"], verification: ["Verified"] }, query: "deploy", expected: [golden[8]!.id] },
    { filter: { tags: ["deployment"] }, query: "deployment", expected: [golden[4]!.id] },
    { filter: { tags: ["deployment", "backend"] }, query: "deployment", expected: [] },
  ])("applies exact filters through the SDK and independent fixture: $filter", async ({ filter, query, expected }) => {
    const { service } = await setup(); const result = await service.search({ query, depth: "metadata", ...filter });
    expect(result.results.map((item) => item.id)).toEqual(expected); expect(result.diagnostics.bodiesScanned).toBe(0);
  });
  it("reports inline relation truncation without hidden relation/body fetches in metadata mode", async () => {
    const f = await setup((fetch) => async (input, init) => {
      const response = await fetch(input, init); if (new Request(input, init).method !== "POST") return response;
      const body = await response.json() as { results: { properties: { Project: { has_more: boolean } } }[] };
      body.results[0]!.properties.Project.has_more = true; return Response.json(body);
    });
    const result = await f.service.search({ query: "deploy", depth: "metadata" });
    expect(result.diagnostics.truncationReasons).toEqual(["relation_limit"]);
    expect(result.results.find((item) => item.id === golden[0]!.id)?.relationsTruncated).toBe(true);
    expect(f.api.requests.filter((request) => request.url.includes("/properties/") || request.url.includes("/blocks/"))).toEqual([]);
  });
  it("builds AND relation/tag filters and OR select groups using validated property IDs", async () => {
    const { api, service } = await setup(); const result = await service.search({ query: "deploy", depth: "metadata", projectId: project.id, subprojectId: subproject.id,
      type: ["Reference", "Setup / Runbook"], verification: ["Needs Review", "Draft"], tags: ["deployment"] });
    expect(result.results).toEqual([]); // Only tagged row has no whole-token deploy match.
    const query = api.requests.find((request) => request.method === "POST")!;
    expect(await query.clone().json()).toEqual({ page_size: 50, sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      filter: { and: [{ property: "k_project", relation: { contains: project.id } }, { property: "k_subproject", relation: { contains: subproject.id } },
        { or: [{ property: "k_type", select: { equals: "Reference" } }, { property: "k_type", select: { equals: "Setup / Runbook" } }] },
        { or: [{ property: "k_verify", select: { equals: "Draft" } }, { property: "k_verify", select: { equals: "Needs Review" } }] }, { property: "k_tags", multi_select: { contains: "deployment" } }] } });
    expect(api.requests.some((request) => request.url.includes("/blocks/"))).toBe(false);
  });
  it("retrieves body-only matches through the shared Knowledge service and performs read operations only", async () => {
    const { api, service } = await setup(); const result = await service.search({ query: "deploy node", limit: 25 });
    const bodyOnly = result.results.find((item) => item.id === golden[5]!.id)!; expect(bodyOnly).toMatchObject({ matchedIn: ["body"], score: 135 });
    expect(result.diagnostics).toMatchObject({ bodiesScanned: 10, requestCount: 21, maxRequests: 40 });
    expect(api.requests.every((request) => request.method === "GET" || (request.method === "POST" && request.url.endsWith("/query")))).toBe(true);
  });
  it("maps bounded cursor pagination and rejects malformed pages", async () => {
    const { repository } = await setup(); const budget = createRequestBudget(40);
    try {
      const first = await repository.list(searchInputSchema.parse({ query: "deploy" }), 2, undefined, budget);
      expect(first).toMatchObject({ hasMore: true, nextCursor: "2" }); expect(first.items).toHaveLength(2);
      const second = await repository.list(searchInputSchema.parse({ query: "deploy" }), 2, first.nextCursor!, budget); expect(second.items[0]?.id).not.toBe(first.items[0]?.id); expect(budget.used).toBe(2);
    } finally { budget.dispose(); }
    const bad = await setup((fetch) => async (input, init) => new Request(input, init).method === "POST" ? Response.json({ object: "list", results: [], has_more: true, next_cursor: null }) : fetch(input, init));
    await expect(bad.service.search({ query: "deploy", depth: "metadata" })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it("counts SDK retries as separate outbound attempts in the search budget", async () => {
    let attempts = 0;
    const f = await setup((fetch) => async (input, init) => {
      if (new Request(input, init).method === "POST" && attempts++ === 0) return Response.json({ object: "error", code: "rate_limited", message: "synthetic" }, { status: 429, headers: { "retry-after": "0" } });
      return fetch(input, init);
    });
    const result = await f.service.search({ query: "deploy", depth: "metadata" }); expect(attempts).toBe(2); expect(result.diagnostics.requestCount).toBe(2);
  });
  it("cannot bypass attempt limits through SDK retries", async () => {
    let attempts = 0; const f = await setup((fetch) => async (input, init) => {
      if (new Request(input, init).method === "POST") { attempts++; return Response.json({ object: "error", code: "rate_limited", message: "synthetic" }, { status: 429, headers: { "retry-after": "0" } }); }
      return fetch(input, init);
    });
    const scope = memoryContextRepository(); const bodies = memorySearch().bodies;
    const result = await createSearchService(f.repository, scope, bodies, () => createRequestBudget(1)).search({ query: "deploy", depth: "metadata" });
    expect(attempts).toBe(1); expect(result.diagnostics).toMatchObject({ requestCount: 1, truncated: true, truncationReasons: ["request_budget"] });
  });
  it("keeps the overall deadline effective while the SDK waits to retry", async () => {
    let attempts = 0;
    const f = await setup((fetch) => async (input, init) => {
      if (new Request(input, init).method === "POST") { attempts++; return Response.json({ object: "error", code: "rate_limited", message: "synthetic" }, { status: 429, headers: { "retry-after": "1" } }); }
      return fetch(input, init);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const service = createSearchService(f.repository, f.scope, f.bodies, () => createRequestBudget(40, 50));
    const operation = expect(service.search({ query: "deploy", depth: "metadata" })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(50); await operation; expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); expect(attempts).toBe(1);
  });
  it.each(["fetch", "body"])("aborts pending %s consumption and cannot report a late success", async (phase) => {
    let signal: AbortSignal | undefined; let release!: () => void;
    const f = await setup((fetch) => async (input, init) => {
      const request = new Request(input, init); if (request.method !== "POST") return fetch(input, init);
      signal = request.signal;
      if (phase === "fetch") { await new Promise<void>((resolve) => { release = resolve; }); return fetch(input, init); }
      return new Response(new ReadableStream({ start(controller) { release = () => { try { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } catch { /* Cancelled by deadline. */ } }; } }));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const service = createSearchService(f.repository, f.scope, f.bodies, () => createRequestBudget(40, 50));
    const operation = expect(service.search({ query: "deploy", depth: "metadata" })).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    await vi.advanceTimersByTimeAsync(50); await operation; expect(signal?.aborted).toBe(true); release(); await vi.advanceTimersByTimeAsync(0);
  });
  it("rejects wrong-source metadata and never turns schema failures into an empty success", async () => {
    const f = await setup((fetch) => async (input, init) => {
      const response = await fetch(input, init); if (new Request(input, init).method !== "POST") return response;
      const body = await response.json() as { results: { parent: { data_source_id: string } }[] }; body.results[0]!.parent.data_source_id = project.id; return Response.json(body);
    });
    await expect(f.service.search({ query: "deploy", depth: "metadata" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
