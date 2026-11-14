import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotionClient } from "../src/integrations/notion/client.ts";
import { readNotionBody } from "../src/integrations/notion/deadline.ts";
import { loadConfig } from "../src/config/environment.ts";
import { createNotionSchemaIntegration } from "../src/services/notion-schema.ts";
import { createProjectContextService, createRequestBudget } from "../src/services/project-context.ts";
import { createContextFixtureApi, knowledge, memoryContextRepository, subproject } from "./fixtures/project-context.ts";
import { project, projectRecord } from "./fixtures/projects.ts";
import { validEnvironment } from "./fixtures/environment.ts";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then((value) => ({ status: "success" as const, value }), (error: unknown) => ({ status: "error" as const, error }));
}
async function setup(wrap: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch = (fetch) => fetch) {
  const api = createContextFixtureApi();
  const config = loadConfig(validEnvironment).notion;
  const client = createNotionClient(config, { fetch: wrap(api.fetch) });
  const schemas = await createNotionSchemaIntegration(config, client).initialize();
  return { api, client, schemas, repository: client.createContextRepository(schemas) };
}
function fakeClock() { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); }

describe("context overall deadline through the installed Notion SDK", () => {
  it("aborts a pending in-flight fetch at expiry and clears SDK/deadline timers", async () => {
    let signal: AbortSignal | undefined;
    const { repository } = await setup((fetch) => async (input, init) => {
      if (!String(input).includes("/pages/")) return fetch(input, init);
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    });
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(49);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(signal?.aborted).toBe(true);
    expect(budget.used).toBe(1);
    budget.dispose();
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending response reader and releases its lock at expiry", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const { repository } = await setup((fetch) => async (input, init) => String(input).includes("/pages/")
      ? new Response(body) : fetch(input, init));
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    budget.dispose();
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the production 30-second deadline while a response body is stalled", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }));
    const { repository } = await setup((fetch) => async (input, init) => String(input).includes("/pages/") ? response : fetch(input, init));
    fakeClock();
    let settled = false;
    const result = outcome(createProjectContextService(repository).get({ projectId: project.id })).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an earlier SDK timeout and aborts orphaned fetch work on service cleanup", async () => {
    let signal: AbortSignal | undefined;
    const { repository } = await setup((fetch) => async (input, init) => {
      if (!String(input).includes("/pages/")) return fetch(input, init);
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    fakeClock();
    const result = outcome(createProjectContextService(repository).get({ projectId: project.id }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes a complete context before expiry and disposes all owned resources", async () => {
    const { repository } = await setup();
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = await createProjectContextService(repository, () => budget).get({ projectId: project.id });
    expect(result.project).toEqual(project);
    expect(result.knowledgeCounts.total).toBe(1);
    expect(result.requestBudget.usedRequests).toBe(6);
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(result.knowledgeCounts.total).toBe(1);
  });

  it("expires during SDK retry sleep without waiting for the next attempt", async () => {
    let calls = 0;
    const { repository } = await setup((fetch) => async (input, init) => {
      if (!String(input).includes("/pages/")) return fetch(input, init);
      calls++;
      return Response.json({ object: "error", code: "rate_limited", message: "Synthetic retry" }, { status: 429, headers: { "retry-after": "1" } });
    });
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(budget.used).toBe(1);
    budget.dispose();
    // The SDK has no cancellable sleep API. Its pending sleep may wake, but
    // the shared budget prevents the continuation from issuing another fetch.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges a started retry and aborts it within the original deadline", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const { repository } = await setup((fetch) => async (input, init) => {
      if (!String(input).includes("/pages/")) return fetch(input, init);
      calls++;
      if (calls === 1) return Response.json({ code: "rate_limited", message: "Synthetic retry" }, { status: 429, headers: { "retry-after": "0" } });
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(49);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(signal?.aborted).toBe(true);
    expect(budget.used).toBe(2);
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires on a later relation page without restarting the deadline", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const { api, repository } = await setup((fetch) => async (input, init) => {
      if (!String(input).includes("/properties/")) return fetch(input, init);
      calls++;
      if (calls === 1) return Response.json({ object: "list", results: [], has_more: true, next_cursor: "next" });
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    api.children[0]!.properties.Project.has_more = true;
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getSubproject(subproject.id, budget));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(signal?.aborted).toBe(true);
    expect(budget.used).toBe(3);
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a late fetch success and cancels its newly arrived body", async () => {
    const fetchResult = deferred<Response>();
    const { repository } = await setup((fetch) => async (input, init) => String(input).includes("/pages/") ? fetchResult.promise : fetch(input, init));
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    const response = Response.json(projectRecord());
    const cancel = vi.spyOn(response.body!, "cancel");
    fetchResult.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await result).toMatchObject({ status: "error" });
    budget.dispose();
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("rejects a late text-only adapter %s without an unhandled rejection", async (completion) => {
    const textResult = deferred<string>();
    const response = new Response(null);
    vi.spyOn(response, "text").mockImplementation(() => textResult.promise);
    const { repository } = await setup((fetch) => async (input, init) => String(input).includes("/pages/") ? response : fetch(input, init));
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(repository.getProject(project.id, budget));
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    if (completion === "success") textResult.resolve(JSON.stringify(projectRecord()));
    else textResult.reject(new Error("Synthetic late adapter failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ status: "error" });
    budget.dispose();
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates expiry from a concurrent operation on the same SDK client", async () => {
    const stalled = deferred<Response>();
    const { repository } = await setup((fetch) => async (input, init) => String(input).endsWith("/pages/" + project.id) ? stalled.promise : fetch(input, init));
    fakeClock();
    const first = createRequestBudget(20, 50);
    const second = createRequestBudget(20, 200);
    const failed = outcome(repository.getProject(project.id, first));
    const success = repository.getSubproject(subproject.id, second);
    expect(await success).toEqual(subproject);
    await vi.advanceTimersByTimeAsync(50);
    expect(await failed).toMatchObject({ status: "error" });
    expect(second.signal.aborted).toBe(false);
    expect(first.used).toBe(1);
    expect(second.used).toBe(1);
    stalled.resolve(Response.json(projectRecord()));
    await vi.advanceTimersByTimeAsync(0);
    first.dispose(); second.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attach the context deadline to concurrent list_projects reads", async () => {
    const stalled = deferred<Response>();
    let listingSignal: AbortSignal | null | undefined;
    const { client, schemas, repository } = await setup((fetch) => async (input, init) => {
      if (String(input).includes("/pages/")) return stalled.promise;
      if (String(input).endsWith("/query")) {
        listingSignal = init?.signal;
        return Response.json({ object: "list", results: [projectRecord()], has_more: false, next_cursor: null });
      }
      return fetch(input, init);
    });
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const context = outcome(repository.getProject(project.id, budget));
    const listing = await client.createProjectRepository(schemas.projects).list({ limit: 1 });
    expect(listing).toEqual({ projects: [project], hasMore: false, nextCursor: null });
    expect(listingSignal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50);
    expect(await context).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    expect(budget.used).toBe(1);
    stalled.resolve(Response.json(projectRecord()));
    await vi.advanceTimersByTimeAsync(0);
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("service deadline and cleanup", () => {
  it("cancels headers-ready bodies if the deadline expired before reading began", async () => {
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const response = Response.json(projectRecord());
    const cancel = vi.spyOn(response.body!, "cancel");
    await vi.advanceTimersByTimeAsync(50);
    await expect(readNotionBody(response, budget)).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXCEEDED" });
    expect(cancel).toHaveBeenCalledOnce();
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not continue scanning or publish partial success after a late repository completion", async () => {
    const page = deferred<{ items: typeof knowledge[]; hasMore: boolean; nextCursor: null }>();
    const repository = memoryContextRepository();
    const list = vi.spyOn(repository, "listKnowledge").mockImplementation(() => page.promise);
    const scan = vi.spyOn(repository, "scanKnowledge");
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(createProjectContextService(repository, () => budget).get({ projectId: project.id }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    page.resolve({ items: [knowledge], hasMore: false, nextCursor: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledOnce();
    expect(scan).not.toHaveBeenCalled();
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans timers/listeners on an ordinary error and preserves that error", async () => {
    fakeClock();
    const budget = createRequestBudget(20, 50);
    const result = outcome(createProjectContextService(memoryContextRepository(), () => budget).get({ projectId: knowledge.id }));
    expect(await result).toMatchObject({ status: "error", error: { code: "NOT_FOUND" } });
    expect(getEventListeners(budget.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects completion beyond the monotonic deadline even before its timer runs", async () => {
    fakeClock();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const budget = createRequestBudget(20, 50);
    const result = outcome(budget.run(async () => { clock = 51; return "late"; }));
    expect(await result).toMatchObject({ status: "error", error: { code: "REQUEST_BUDGET_EXCEEDED" } });
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
