import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { captureRichText, captureBlockPayload } from "../src/integrations/notion/capture-knowledge.ts";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { createCaptureService } from "../src/services/capture-knowledge.ts";
import { createRequestBudget } from "../src/services/request-budget.ts";
import { validateCapture } from "../src/domain/capture-knowledge.ts";
import { createCaptureFixtureApi, captureInput, capturedPage } from "./fixtures/capture-knowledge.ts";
import { validEnvironment } from "./fixtures/environment.ts";
import { subproject, memoryContextRepository } from "./fixtures/project-context.ts";
import { sourceIds } from "./fixtures/notion.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) {
  const api = createCaptureFixtureApi(); const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: wrap ? wrap(api.fetch) : api.fetch });
  const schemas = await createNotionSchemaIntegration(config, client).initialize();
  const writer = client.createCaptureWriter(schemas);
  const service = createCaptureService(writer, client.createContextRepository(schemas));
  return { api, writer, service };
}
describe("create-only Notion capture through the installed SDK", () => {
  it("uses approved property and option IDs, exact parent and separate create/append requests", async () => {
    const { api, service } = await setup();
    const result = await service.capture({ ...captureInput, subprojectId: subproject.id, context: "Context", filePaths: ["src/index.ts"],
      sourceUrl: "https://example.test/source", tags: ["auth"], verification: "Needs Review", content: "# Body" });
    expect(result.entry).toEqual({ ...capturedPage, verification: "Needs Review" });
    expect(api.creates).toHaveLength(1); expect(api.appends).toHaveLength(1);
    expect(api.creates[0]).toEqual({ parent: { type: "data_source_id", data_source_id: sourceIds.knowledge }, properties: {
      title: { title: [{ type: "text", text: { content: captureInput.title } }] }, k_type: { select: { id: "k_type_option_0" } },
      k_verify: { select: { id: "k_verify_option_3" } }, k_project: { relation: [{ id: captureInput.projectId }] },
      k_subproject: { relation: [{ id: subproject.id }] }, k_context: { rich_text: [{ type: "text", text: { content: "Context" } }] },
      k_files: { rich_text: [{ type: "text", text: { content: "src/index.ts" } }] }, k_url: { url: "https://example.test/source" }, k_tags: { multi_select: [{ id: "k_tags_option_6" }] },
    } });
    expect(api.appends[0]).toMatchObject({ children: [{ type: "heading_1" }] });
    const writes = api.requests.filter((request) => request.method !== "GET" && !request.url.endsWith("/query"));
    expect(writes.map((request) => [request.method, new URL(request.url).pathname])).toEqual([["POST", "/v1/pages"], ["PATCH", "/v1/blocks/" + capturedPage.id + "/children"]]);
    const query = api.requests.find((request) => request.method === "POST" && request.url.endsWith("/query"))!;
    expect((await query.clone().json()).filter.and).toContainEqual({ property: "k_project", relation: { contains: captureInput.projectId } });
    expect(JSON.stringify(api.creates)).not.toContain('"name":');
  });
  it("omits unspecified optional properties and sends Draft's existing option ID", async () => {
    const { api, service } = await setup(); await service.capture(captureInput);
    expect(Object.keys((api.creates[0]?.properties ?? {}) as object).sort()).toEqual(["k_project", "k_type", "k_verify", "title"]);
    expect(api.creates[0]).toMatchObject({ properties: { k_verify: { select: { id: "k_verify_option_0" } } } }); expect(api.appends).toHaveLength(0);
  });
  it("rejects schema changes, unknown choices and missing option IDs before writes", async () => {
    for (const mode of ["type", "tag", "id", "property", "relation"]) {
      let reads = 0;
      const { api, service } = await setup((fetch) => async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).endsWith("/data_sources/" + sourceIds.knowledge) || ++reads === 1) return response;
        const data = await response.json() as { properties: Record<string, Record<string, unknown>> };
        if (mode === "property") data.properties.Type!.type = "rich_text";
        else if (mode === "relation") data.properties.Project!.relation = { data_source_id: sourceIds.subprojects };
        else {
          const field = mode === "tag" ? data.properties.Tags!.multi_select : data.properties.Type!.select;
          const options = (field as { options: Record<string, unknown>[] }).options;
          if (mode === "id") Reflect.deleteProperty(options[0]!, "id"); else options[0]!.name = "Unknown choice";
        }
        return Response.json(data);
      });
      await expect(service.capture(captureInput)).rejects.toMatchObject({ code: "SCHEMA_DRIFT" }); expect(api.creates).toHaveLength(0); expect(api.appends).toHaveLength(0);
    }
  });
  it("chunks rich text without splitting surrogate pairs and supports literal code", () => {
    const text = "x".repeat(1999) + "😀" + "y".repeat(2000);
    const chunks = captureRichText(text);
    expect(chunks.every((part) => part.text.content.length <= 2000)).toBe(true);
    expect(chunks.map((part) => part.text.content).join("")).toBe(text);
    expect(chunks.some((part) => /[\uD800-\uDBFF]$/.test(part.text.content))).toBe(false);
    expect(captureBlockPayload({ type: "code", text: "literal ` code", language: "unknown" })).toMatchObject({ code: { language: "plain text" } });
  });
  it("sends 201 blocks as 100/100/1 append batches within the shared budget", async () => {
    const { api, service } = await setup();
    const result = await service.capture({ ...captureInput, content: "- item\n".repeat(201) });
    expect(api.creates).toHaveLength(1); expect(api.appends.map((batch) => (batch.children as object[]).length)).toEqual([100, 100, 1]);
    expect(result.body).toEqual({ complete: true, blocksWritten: 201, batchesWritten: 3 });
    expect(result.requestBudget.usedRequests).toBe(7);
  });
  it.each([400, 401, 403, 429, 503, 529])("never replays page creation after HTTP %i", async (status) => {
    let calls = 0;
    const { api, service } = await setup((fetch) => async (input, init) => {
      if (String(input).endsWith("/pages") && init?.method === "POST") {
        calls++; return Response.json({ code: status === 429 ? "rate_limited" : "service_unavailable", message: "private submitted content" }, { status, headers: { "retry-after": "0" } });
      }
      return fetch(input, init);
    });
    const expected = status >= 500 ? "WRITE_OUTCOME_UNKNOWN" : status === 400 ? "VALIDATION_ERROR" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "RATE_LIMITED";
    await expect(service.capture({ ...captureInput, content: "Body" })).rejects.toMatchObject({ code: expected });
    expect(calls).toBe(1); expect(api.appends).toHaveLength(0);
  });
  it("reports an unknown creation outcome on network failure without appending", async () => {
    let calls = 0;
    const { service } = await setup((fetch) => async (input, init) => {
      if (String(input).endsWith("/pages") && init?.method === "POST") { calls++; throw new Error("private network detail"); }
      return fetch(input, init);
    });
    await expect(service.capture(captureInput)).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" }); expect(calls).toBe(1);
  });
  it.each([429, 503, 529])("returns recoverable partial progress and never replays append after HTTP %i", async (status) => {
    let calls = 0;
    const { api, service } = await setup((fetch) => async (input, init) => {
      if (init?.method === "PATCH") {
        calls++; if (calls === 2) return Response.json({ code: "rate_limited", message: "private" }, { status, headers: { "retry-after": "0" } });
      }
      return fetch(input, init);
    });
    await expect(service.capture({ ...captureInput, content: "- item\n".repeat(201) })).rejects.toMatchObject({ code: "PARTIAL_WRITE", recovery: {
      pageId: capturedPage.id, url: capturedPage.url, confirmedBatches: 1, confirmedBlocks: 100, totalBlocks: 201, bodyComplete: false,
      failedBatchOutcome: status >= 500 ? "unknown" : "rejected", doNotRetryCapture: true,
    } });
    expect(calls).toBe(2); expect(api.creates).toHaveLength(1); expect(api.appends).toHaveLength(1);
  });
  it("denies forged bindings, cross-budget append targets and Verified even at the repository boundary", async () => {
    const { api, writer } = await setup(); const budget = createRequestBudget();
    try {
      await expect(writer.create(validateCapture(captureInput), { properties: {}, options: {} }, budget)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(writer.append(capturedPage, [{ type: "paragraph", text: "Body" }], budget)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const bindings = await writer.prepare(budget);
      await expect(writer.create({ ...validateCapture(captureInput), verification: "Verified" } as unknown as ReturnType<typeof validateCapture>, bindings, budget)).rejects.toMatchObject({ code: "VERIFICATION_REQUIRES_HUMAN" });
      expect(api.creates).toHaveLength(0); expect(api.appends).toHaveLength(0);
    } finally { budget.dispose(); }
  });
  it("retains recovery identity when the overall deadline expires during append body consumption", async () => {
    const cancel = vi.fn();
    const { api, writer } = await setup((fetch) => async (input, init) => init?.method === "PATCH"
      ? new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })) : fetch(input, init));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const service = createCaptureService(writer, memoryContextRepository(), () => createRequestBudget(20, 50));
    const outcome = service.capture({ ...captureInput, content: "Body" }).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: "PARTIAL_WRITE", recovery: { pageId: capturedPage.id, confirmedBlocks: 0, failedBatchOutcome: "unknown" } });
    expect(cancel).toHaveBeenCalledOnce(); expect(api.creates).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("reports unknown creation outcome and aborts an in-flight create at expiry", async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const { writer } = await setup((fetch) => async (input, init) => {
      if (String(input).endsWith("/pages") && init?.method === "POST") {
        calls++; signal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      }
      return fetch(input, init);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const outcome = createCaptureService(writer, memoryContextRepository(), () => createRequestBudget(20, 50)).capture(captureInput).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" }); expect(signal?.aborted).toBe(true); expect(calls).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("charges read retries to the same budget without retrying mutations", async () => {
    let attempts = 0;
    const { api, service } = await setup((fetch) => async (input, init) => {
      if (String(input).includes("/pages/")) { attempts++; if (attempts === 1) return Response.json({ object: "error", code: "rate_limited", message: "Synthetic rate limit" }, { status: 429, headers: { "retry-after": "0" } }); }
      return fetch(input, init);
    });
    const result = await service.capture({ ...captureInput, content: "Body" });
    expect(attempts).toBe(2); expect(result.requestBudget.usedRequests).toBe(6); expect(api.creates).toHaveLength(1); expect(api.appends).toHaveLength(1);
  });
  it("does not accept a late create response or start an append after expiry", async () => {
    let resolve!: (value: Response) => void;
    const deferred = new Promise<Response>((done) => { resolve = done; });
    let creates = 0;
    const { api, writer } = await setup((fetch) => async (input, init) => {
      if (String(input).endsWith("/pages") && init?.method === "POST") { creates++; return deferred; }
      return fetch(input, init);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const outcome = createCaptureService(writer, memoryContextRepository(), () => createRequestBudget(20, 50)).capture({ ...captureInput, content: "Body" }).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    const response = Response.json({ object: "page", ...capturedPage, parent: { type: "data_source_id", data_source_id: sourceIds.knowledge } });
    const cancel = vi.spyOn(response.body!, "cancel"); resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(creates).toBe(1); expect(api.appends).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["create", "append"])("does not report success after malformed %s acknowledgement", async (operation) => {
    const { api, service } = await setup((fetch) => async (input, init) => {
      const response = await fetch(input, init);
      if (operation === "create" && init?.method === "POST" && String(input).endsWith("/pages")) return Response.json({ object: "page", id: "invalid" });
      if (operation === "append" && init?.method === "PATCH") return Response.json({ object: "list", results: [] });
      return response;
    });
    await expect(service.capture({ ...captureInput, content: "Body" })).rejects.toMatchObject(operation === "create"
      ? { code: "WRITE_OUTCOME_UNKNOWN" } : { code: "PARTIAL_WRITE", recovery: { pageId: capturedPage.id, confirmedBlocks: 0, failedBatchOutcome: "unknown" } });
    expect(api.creates).toHaveLength(1); expect(api.appends).toHaveLength(operation === "append" ? 1 : 0);
  });
  it("preserves partial recovery on an earlier SDK append timeout and cancels orphaned I/O", async () => {
    let signal: AbortSignal | undefined;
    let attempts = 0;
    const { writer, api } = await setup((fetch) => async (input, init) => {
      if (init?.method === "PATCH") {
        attempts++; signal = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      }
      return fetch(input, init);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const outcome = createCaptureService(writer, memoryContextRepository()).capture({ ...captureInput, content: "Body" }).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({ code: "PARTIAL_WRITE", recovery: { pageId: capturedPage.id, failedBatchOutcome: "unknown" } });
    expect(signal?.aborted).toBe(true); expect(attempts).toBe(1); expect(api.creates).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps concurrent capture write capabilities and budgets isolated", async () => {
    const { api, service } = await setup();
    const results = await Promise.all([service.capture({ ...captureInput, content: "First" }), service.capture({ ...captureInput, content: "Second" })]);
    expect(results.map((result) => result.requestBudget.usedRequests)).toEqual([5, 5]);
    expect(api.creates).toHaveLength(2); expect(api.appends).toHaveLength(2);
  });
});
