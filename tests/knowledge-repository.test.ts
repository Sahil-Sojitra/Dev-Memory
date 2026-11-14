import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { mapBodyBlock } from "../src/integrations/notion/knowledge-entry.ts";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { createKnowledgeEntryService } from "../src/services/knowledge-entry.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { createKnowledgeFixtureApi, detail, wireBlock } from "./fixtures/knowledge-entry.ts";
import { validEnvironment, FAKE_NOTION_TOKEN } from "./fixtures/environment.ts";
import { subproject } from "./fixtures/project-context.ts";
import { project } from "./fixtures/projects.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) {
  const api = createKnowledgeFixtureApi();
  const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: wrap ? wrap(api.fetch) : api.fetch });
  const schemas = await createNotionSchemaIntegration(config, client).initialize();
  const repository = client.createKnowledgeEntryRepository(schemas.knowledge);
  return { api, repository, service: createKnowledgeEntryService(repository) };
}
describe("knowledge read-only repository through the installed SDK", () => {
  it("maps metadata and reads body through budgeted GETs only", async () => {
    const { api, service } = await setup();
    const result = await service.get({ pageId: detail.id });
    expect(result.entry).toEqual(detail);
    expect(result.content.markdown).toBe("Readable content");
    expect(result.requestBudget.usedRequests).toBe(2);
    expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    const bodyRequest = api.requests.find((request) => request.url.includes("/blocks/"))!;
    expect(new URL(bodyRequest.url).searchParams.get("page_size")).toBe("100");
    expect(JSON.stringify(result)).not.toMatch(/properties|data_source_id|created_by/);
  });
  it("rejects missing, wrong-source, archived and non-database pages safely", async () => {
    const { api, service } = await setup();
    await expect(service.get({ pageId: project.id })).rejects.toMatchObject({ code: "NOT_IN_KNOWLEDGE_DB" });
    await expect(service.get({ pageId: "90000000-0000-4000-8000-000000000001" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    api.record.parent.data_source_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "NOT_IN_KNOWLEDGE_DB" });
    Object.assign(api.record.parent, { type: "page_id" });
    await expect(service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "NOT_IN_KNOWLEDGE_DB" });
    Object.assign(api.record, { archived: true });
    await expect(service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(api.requests.filter((request) => request.url.includes("/blocks/"))).toHaveLength(0);
  });
  it("uses validated property IDs after names change and invalidates cached bodies on edit", async () => {
    const { api, service } = await setup();
    await service.get({ pageId: detail.id });
    expect((await service.get({ pageId: detail.id })).cacheHit).toBe(true);
    const properties = api.record.properties;
    Object.assign(properties, { RenamedTitle: properties.Name }); Reflect.deleteProperty(properties, "Name");
    properties["Last Updated"].last_edited_time = "2026-11-03T00:00:00.000Z";
    api.blocks.set(detail.id, [wireBlock(1, "paragraph", "Updated body")]);
    const result = await service.get({ pageId: detail.id });
    expect(result.cacheHit).toBe(false);
    expect(result.content.markdown).toBe("Updated body");
  });
  it("paginates both relations with the same budget and detects cursor cycles", async () => {
    let reads = 0;
    const { api, service } = await setup((fetch) => async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/properties/")) {
        reads++;
        const next = url.searchParams.has("start_cursor");
        const target = url.pathname.includes("k_project") ? project.id : subproject.id;
        return Response.json({ object: "list", results: [{ object: "property_item", type: "relation", relation: { id: target } }], has_more: !next, next_cursor: next ? null : "next" });
      }
      return fetch(input, init);
    });
    Object.assign(api.record.properties.Project, { has_more: true });
    Object.assign(api.record.properties.Subproject, { has_more: true });
    const result = await service.get({ pageId: detail.id });
    expect(reads).toBe(4);
    expect(result.requestBudget.usedRequests).toBe(6);
    expect(result.entry.projectIds).toEqual([project.id]);
    expect(result.entry.subprojectIds).toEqual([subproject.id]);
    const cyclic = await setup((fetch) => async (input, init) => String(input).includes("/properties/")
      ? Response.json({ object: "list", results: [], has_more: true, next_cursor: "cycle" }) : fetch(input, init));
    Object.assign(cyclic.api.record.properties.Project, { has_more: true });
    await expect(cyclic.service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it("flags partial relations and content when attempts run out after metadata", async () => {
    const { api, repository } = await setup();
    Object.assign(api.record.properties.Project, { has_more: true });
    const result = await createKnowledgeEntryService(repository, () => createRequestBudget(1)).get({ pageId: detail.id });
    expect(result.entry).toMatchObject({ relationsTruncated: true, relationTruncationReasons: ["request_budget"], projectIds: [project.id] });
    expect(result.content.reasons).toContain("request_budget");
    expect(result.truncated).toBe(true);
    expect(result.requestBudget.usedRequests).toBe(1);
  });
  it("retrieves nested and paginated child blocks and bounds retry attempts", async () => {
    let retries = 0;
    const { api, repository } = await setup((fetch) => async (input, init) => {
      if (String(input).includes("/blocks/") && retries++ < 1) return Response.json({ code: "rate_limited", message: "private " + FAKE_NOTION_TOKEN }, { status: 429, headers: { "retry-after": "0" } });
      return fetch(input, init);
    });
    const parent = wireBlock(1, "toggle", "Parent", true);
    api.blocks.set(detail.id, [parent, ...Array.from({ length: 100 }, (_, i) => wireBlock(i + 3))]);
    api.blocks.set(parent.id, [wireBlock(2, "paragraph", "Child")]);
    const result = await createKnowledgeEntryService(repository).get({ pageId: detail.id });
    expect(result.content).toMatchObject({ blocksRead: 102, truncated: false });
    expect(result.content.markdown).toContain("  Child");
    expect(result.requestBudget.usedRequests).toBe(5);
    retries = 0;
    const partial = await createKnowledgeEntryService(repository, () => createRequestBudget(2)).get({ pageId: detail.id });
    expect(partial.content).toMatchObject({ truncated: true, reasons: ["request_budget"] });
    expect(partial.requestBudget.usedRequests).toBe(2);
  });
  it("aborts pending block response bodies at the original overall deadline", async () => {
    const cancel = vi.fn();
    const { repository } = await setup((fetch) => async (input, init) => String(input).includes("/blocks/")
      ? new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })) : fetch(input, init));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pending = createKnowledgeEntryService(repository, () => createRequestBudget(20, 50)).get({ pageId: detail.id });
    const error = pending.catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);
    expect(await error).toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves annotations, safe links and raw code while rejecting dangerous URLs", () => {
    const raw = wireBlock();
    Object.assign(raw, { paragraph: { rich_text: [{ plain_text: "bold", annotations: { bold: true }, href: "https://example.test/(link)" }] } });
    expect(mapBodyBlock(raw).markdown).toBe("[**bold**](https://example.test/%28link%29)");
    Object.assign(raw, { paragraph: { rich_text: [{ plain_text: "safe", href: "javascript:alert(1)" }] } });
    expect(mapBodyBlock(raw).markdown).toBe("safe");
    const code = wireBlock(2, "code", "a`b"); Object.assign(code, { code: { rich_text: [{ plain_text: "a`b" }], language: "javascript" } });
    expect(mapBodyBlock(code).text).toBe("a`b");
  });
  it("rejects malformed block pagination and malformed known block payloads", async () => {
    expect(() => mapBodyBlock({ ...wireBlock(), paragraph: { rich_text: "invalid" } })).toThrow();
    expect(mapBodyBlock({ ...wireBlock(1, "future_block"), future_block: "opaque future payload" })).toMatchObject({ type: "future_block", text: "", markdown: "" });
    const { service } = await setup((fetch) => async (input, init) => String(input).includes("/blocks/")
      ? Response.json({ object: "list", results: [], has_more: true, next_cursor: null }) : fetch(input, init));
    await expect(service.get({ pageId: detail.id })).rejects.toMatchObject({ code: "SCHEMA_DRIFT" });
  });
  it("bounds expanded relations at 1000 IDs and exposes metadata truncation", async () => {
    const { api, service } = await setup((fetch) => async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.includes("/properties/")) return fetch(input, init);
      const offset = Number(url.searchParams.get("start_cursor") ?? 0);
      const results = Array.from({ length: 100 }, (_, index) => ({ object: "property_item", type: "relation", relation: {
        id: "60000000-0000-4000-8000-" + String(offset + index).padStart(12, "0"),
      } }));
      return Response.json({ object: "list", results, has_more: true, next_cursor: String(offset + 100) });
    });
    Object.assign(api.record.properties.Project, { has_more: true });
    const result = await service.get({ pageId: detail.id });
    expect(result.entry.projectIds).toHaveLength(1000);
    expect(result.entry.relationTruncationReasons).toEqual(["relation_limit"]);
    expect(result.truncated).toBe(true);
    expect(result.content.truncated).toBe(false);
  });
  it("isolates concurrent knowledge invocations on the shared SDK client", async () => {
    const { repository } = await setup();
    let sequence = 0;
    const service = createKnowledgeEntryService(repository, () => createRequestBudget(sequence++ === 0 ? 0 : 20));
    const [failed, successful] = await Promise.allSettled([service.get({ pageId: detail.id }), service.get({ pageId: detail.id })]);
    expect(failed.status).toBe("rejected");
    expect(successful.status).toBe("fulfilled");
    if (successful.status === "fulfilled") expect(successful.value.requestBudget.usedRequests).toBe(2);
  });
});
