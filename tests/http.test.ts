import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createHttpApplication, HTTP_INITIALIZATION_RETRY_MS, HTTP_REQUEST_LIMIT_BYTES, HTTP_REQUEST_TIMEOUT_MS, HTTP_RESPONSE_LIMIT_BYTES } from "../src/transports/http.ts";
import { createNotionSchemaReader } from "../src/integrations/notion/client.ts";
import { loadConfig } from "../src/config/environment.ts";
import type { Environment } from "../src/config/environment.ts";
import type { ProjectRepository } from "../src/domain/projects.ts";
import { FAKE_BEARER_SHA256, FAKE_BEARER_TOKEN, FAKE_NEXT_SHA256, FAKE_NEXT_TOKEN, FAKE_NOTION_TOKEN, validHttpEnvironment } from "./fixtures/environment.ts";
import { createFixtureApi, databaseIds, sourceIds } from "./fixtures/notion.ts";
import { inMemoryProjects, project } from "./fixtures/projects.ts";
import { createContextFixtureApi } from "./fixtures/project-context.ts";
import type { WireReply } from "./fixtures/mcp.ts";
import { createKnowledgeFixtureApi, detail } from "./fixtures/knowledge-entry.ts";
import { createCaptureFixtureApi, captureInput, capturedPage } from "./fixtures/capture-knowledge.ts";
import { createSearchFixtureApi, golden } from "./fixtures/search-knowledge.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(environment: Environment = validHttpEnvironment, repository: ProjectRepository = inMemoryProjects()) {
  const api = createFixtureApi();
  const schemaReader = createNotionSchemaReader(loadConfig(validHttpEnvironment).notion, { fetch: api.fetch });
  const logs: string[] = [];
  const list = vi.fn(repository.list);
  const application = createHttpApplication(() => environment, {
    schemaReader, projectRepository: { list }, destination: { write(line: string) { logs.push(line); } },
  });
  return { application, api, logs, list };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "kan10-tests", version: "1.0.0" } } };
function request(body: unknown = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, options: { token?: string; path?: string; method?: string; headers?: Record<string, string>; raw?: string; url?: string } = {}): Request {
  const method = options.method ?? "POST";
  return new Request(options.url ?? "https://memory.example.test" + (options.path ?? "/api/mcp"), {
    method, headers: { authorization: "Bearer " + (options.token ?? FAKE_BEARER_TOKEN), accept: "application/json, text/event-stream", "content-type": "application/json", ...options.headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body: options.raw ?? JSON.stringify(body) }),
  });
}

async function reply(response: Response): Promise<WireReply> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split(/\r?\n/).find((part) => part.startsWith("data:"));
    return JSON.parse(line?.slice(5) ?? "{}");
  }
  return JSON.parse(text || "{}");
}

describe("HTTP authentication boundary", () => {
  it.each([undefined, "", "Bearer ", "Basic synthetic", "Bearer wrong-token-with-at-least-32-characters", "Bearer " + FAKE_BEARER_TOKEN + ", Bearer " + FAKE_NEXT_TOKEN])("rejects %s uniformly before body consumption or initialization", async (authorization) => {
    const { application, api, list, logs } = setup();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; throw new Error("Body must not be read"); } }, { highWaterMark: 0 });
    const headers = new Headers({ "content-type": "application/json" });
    if (authorization !== undefined) headers.set("authorization", authorization);
    const input = new Request("https://memory.example.test/api/mcp", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    const response = await application.fetch(input);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="devmemory"');
    expect(input.bodyUsed).toBe(false);
    expect(pulls).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
    expect(logs.join("")).not.toContain(FAKE_BEARER_TOKEN);
    expect(logs.join("")).not.toContain(FAKE_NEXT_TOKEN);
  });
  it("accepts both rotation slots and never logs plaintext tokens or digests", async () => {
    const { application, logs } = setup({ ...validHttpEnvironment, MCP_BEARER_TOKEN_NEXT_SHA256: FAKE_NEXT_SHA256 });
    for (const token of [FAKE_BEARER_TOKEN, FAKE_NEXT_TOKEN]) {
      const response = await application.fetch(request(undefined, { token }));
      expect(response.status).toBe(200);
      expect((await reply(response)).result?.tools?.[0]?.name).toBe("list_projects");
    }
    for (const secret of [FAKE_BEARER_TOKEN, FAKE_NEXT_TOKEN, FAKE_BEARER_SHA256, FAKE_NEXT_SHA256, FAKE_NOTION_TOKEN]) expect(logs.join("")).not.toContain(secret);
  });
  it("revalidates current digests for every request during rotation", async () => {
    let env = { ...validHttpEnvironment, MCP_BEARER_TOKEN_NEXT_SHA256: FAKE_NEXT_SHA256 };
    const api = createFixtureApi();
    const application = createHttpApplication(() => env, {
      schemaReader: createNotionSchemaReader(loadConfig(validHttpEnvironment).notion, { fetch: api.fetch }),
      destination: { write() {} },
    });
    expect((await application.fetch(request())).status).toBe(200);
    env = { ...env, MCP_BEARER_TOKEN_SHA256: FAKE_NEXT_SHA256 };
    expect((await application.fetch(request())).status).toBe(401);
    expect((await application.fetch(request(undefined, { token: FAKE_NEXT_TOKEN }))).status).toBe(200);
    expect(api.requests).toHaveLength(6);
  });
  it("fails closed on absent or invalid HTTP configuration", async () => {
    for (const env of [{}, { ...validHttpEnvironment, MCP_BEARER_TOKEN_SHA256: "invalid" }, { ...validHttpEnvironment, MCP_TRANSPORT: "stdio" }]) {
      const { application, api } = setup(env);
      const response = await application.fetch(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(FAKE_BEARER_TOKEN);
      expect(api.requests).toHaveLength(0);
    }
  });
  it("logs configuration names and codes privately while preserving safe HTTP responses", async () => {
    const { application, api, list, logs } = setup({
      ...validHttpEnvironment, MCP_BEARER_TOKEN: FAKE_BEARER_TOKEN,
      MCP_BEARER_TOKEN_NEXT_SHA256: "", NOTION_API: "synthetic invalid token",
    });
    const response = await application.fetch(new Request("https://memory.example.test/api/mcp"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("CONFIGURATION_ERROR");
    const record = JSON.parse(logs[0]!) as { msg: string; invalidFields: string[]; configurationIssues: { field: string; code: string }[] };
    expect(record.msg).toBe("http_configuration_failed");
    expect(record.invalidFields).toEqual(expect.arrayContaining(["MCP_BEARER_TOKEN", "MCP_BEARER_TOKEN_NEXT_SHA256", "NOTION_API"]));
    expect(record.configurationIssues).toEqual(expect.arrayContaining([
      { field: "MCP_BEARER_TOKEN", code: "invalid_type" },
      { field: "MCP_BEARER_TOKEN_NEXT_SHA256", code: "invalid_format" },
      { field: "NOTION_API", code: "invalid_format" },
    ]));
    for (const issue of record.configurationIssues) expect(Object.keys(issue).sort()).toEqual(["code", "field"]);
    for (const secret of [FAKE_BEARER_TOKEN, FAKE_BEARER_SHA256, FAKE_NOTION_TOKEN, "synthetic invalid token"]) expect(logs.join("") + body).not.toContain(secret);
    expect(body).not.toContain("invalidFields");
    expect(body).not.toContain("configurationIssues");
    const ready = await application.fetch(new Request("https://memory.example.test/api/ready"));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready" });
    expect(api.requests).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
  });
  it("diagnoses an omitted HTTP transport without initializing Notion", async () => {
    const { application, api, logs } = setup({ ...validHttpEnvironment, MCP_TRANSPORT: undefined });
    expect((await application.fetch(new Request("https://memory.example.test/api/mcp"))).status).toBe(503);
    expect(JSON.parse(logs[0]!).configurationIssues).toEqual([{ field: "MCP_TRANSPORT", code: "http_transport_required" }]);
    expect(api.requests).toHaveLength(0);
  });
});

describe("stateless Streamable HTTP protocol", () => {
  it("uses shared search services over independent authenticated HTTP requests", async () => {
    const api = createSearchFixtureApi(golden, new Map([[golden[5]!.id, "deploy node"]]));
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
    const application = createHttpApplication(() => validHttpEnvironment, { destination: { write() {} } });
    for (let id = 1; id <= 2; id++) {
      const response = await application.fetch(request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_knowledge", arguments: { query: "deploy node", limit: 1 } } }));
      expect(response.status).toBe(200); expect(response.headers.get("mcp-session-id")).toBeNull();
      expect((await reply(response)).result).toMatchObject({ structuredContent: { results: [{ title: "Deploy node" }], diagnostics: { cacheHit: id === 2, maxRequests: 40, requestCount: id === 2 ? 0 : 21 } } });
    }
  });
  it("runs create-only capture through the shared HTTP factory with synthetic writes only", async () => {
    const api = createCaptureFixtureApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
    const application = createHttpApplication(() => validHttpEnvironment, { destination: { write() {} } });
    const invalid = await application.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture_knowledge", arguments: { ...captureInput, verification: "Verified" } } }));
    expect((await reply(invalid)).result?.isError).toBe(true); expect(api.creates).toHaveLength(0);
    const response = await application.fetch(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture_knowledge", arguments: { ...captureInput, content: "Synthetic body" } } }));
    expect(response.status).toBe(200); expect(response.headers.get("mcp-session-id")).toBeNull();
    expect((await reply(response)).result).toMatchObject({ structuredContent: { entry: { ...capturedPage, verification: "Draft" }, body: { complete: true } } });
    expect(api.creates).toHaveLength(1); expect(api.appends).toHaveLength(1);
  });
  it("reads knowledge over independent HTTP requests without requiring a warm body cache", async () => {
    const api = createKnowledgeFixtureApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
    const application = createHttpApplication(() => validHttpEnvironment, { destination: { write() {} } });
    for (let id = 1; id <= 2; id++) {
      const response = await application.fetch(request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_knowledge_entry", arguments: { pageId: detail.id } } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect((await reply(response)).result).toMatchObject({ structuredContent: { entry: detail, content: { markdown: "Readable content" }, cacheHit: id === 2 } });
    }
  });
  it("invokes project context concurrently through HTTP with shared bootstrap and isolated budgets", async () => {
    const api = createContextFixtureApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
    const application = createHttpApplication(() => validHttpEnvironment, { destination: { write() {} } });
    const responses = await Promise.all([1, 2].map((id) => application.fetch(request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_project_context", arguments: { projectId: project.id, recentLimit: 1 } } }))));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect((await reply(response)).result).toMatchObject({ structuredContent: { project, requestBudget: { usedRequests: 6 }, knowledgeCounts: { total: 1 } } });
    }
    expect(api.metadata.requests).toHaveLength(6);
  });
  it("initializes legacy MCP, lists tools, invokes the existing service and returns no session", async () => {
    const { application, list } = setup();
    const initialized = await application.fetch(request(initialize));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("content-type")).toContain("text/event-stream");
    expect((await reply(initialized)).result?.serverInfo?.name).toBe("devmemory");
    const notification = await application.fetch(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(notification.status).toBe(202);
    const tools = await application.fetch(request());
    expect((await reply(tools)).result?.tools?.map((tool) => tool.name)).toEqual(["list_projects", "get_project_context", "get_knowledge_entry", "capture_knowledge", "search_knowledge"]);
    const called = await application.fetch(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: { limit: 1, nameContains: "DEV" } } }));
    expect(called.status).toBe(200);
    const result = await reply(called);
    expect(result.result?.structuredContent).toEqual({ projects: [project], hasMore: false, nextCursor: null });
    expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
    for (const response of [initialized, tools, notification, called]) expect(response.headers.get("mcp-session-id")).toBeNull();
  });
  it("serves independent and concurrent calls with fresh instances and no initialization affinity", async () => {
    const { application, api } = setup();
    const close = vi.spyOn(McpServer.prototype, "close");
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => application.fetch(request({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: "list_projects", arguments: { limit: index + 1 } } }))));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect((await reply(response)).result?.structuredContent?.projects).toEqual([project]);
    }
    expect(new Set(close.mock.instances).size).toBe(5);
    expect(api.requests).toHaveLength(6);
    expect((await reply(await setup().application.fetch(request()))).result?.tools).toHaveLength(5);
  });
  it("supports modern discovery/list/call with JSON and rejects subscriptions without opening a stream", async () => {
    const { application } = setup();
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "kan10-modern", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    async function modern(method: string, params: Record<string, unknown> = {}) {
      return application.fetch(request({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }, { headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}) } }));
    }
    const discovery = await modern("server/discover");
    expect(discovery.headers.get("content-type")).toContain("application/json");
    expect((await reply(discovery)).result).toMatchObject({ capabilities: { tools: { listChanged: false } } });
    expect((await reply(await modern("tools/list"))).result?.tools).toHaveLength(5);
    expect((await reply(await modern("tools/call", { name: "list_projects", arguments: { limit: 1 } }))).error).toBeUndefined();
    const listen = await modern("subscriptions/listen", { notifications: { tools: { listChanged: true } } });
    expect(listen.headers.get("content-type")).toContain("application/json");
    expect((await reply(listen)).error?.code).toBe(-32603);
  });
  it.each(["GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"])("rejects authenticated %s without initialization", async (method) => {
    const { application, api } = setup();
    const response = await application.fetch(request(undefined, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(api.requests).toHaveLength(0);
  });
  it.each(["{", "", "null", "[]", '{"unexpected":true}'])("safely rejects malformed JSON or MCP %s", async (raw) => {
    const { application, list } = setup();
    const response = await application.fetch(request(undefined, { raw }));
    const value = await reply(response);
    expect(value.error || (value.result?.isError ? value.result : undefined)).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });
  it("maps service errors without leaking secrets or stacks", async () => {
    const { application, logs } = setup(validHttpEnvironment, { list: async () => { throw new Error("Bearer " + FAKE_BEARER_TOKEN + " " + FAKE_NOTION_TOKEN); } });
    const response = await application.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects" } }));
    const body = await response.text();
    expect(body).toContain("INTERNAL_ERROR");
    expect(body + logs.join("")).not.toContain(FAKE_BEARER_TOKEN);
    expect(body + logs.join("")).not.toContain(FAKE_NOTION_TOKEN);
    expect(body).not.toContain('"stack"');
  });
  it("does not reflect a presented credential in an SDK unknown-tool error", async () => {
    const { application, logs } = setup();
    const response = await application.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: FAKE_BEARER_TOKEN } }));
    const body = await response.text();
    expect(body).not.toContain(FAKE_BEARER_TOKEN);
    expect(logs.join("")).not.toContain(FAKE_BEARER_TOKEN);
  });
});

describe("HTTP security limits and lifecycle", () => {
  it.each([
    { headers: { host: "evil.example.test" } },
    { headers: { host: "memory.example.test, evil.example.test" } },
    { headers: { origin: "https://evil.example.test" } },
    { headers: { origin: "null" } },
    { url: "https://evil.example.test/api/mcp", headers: { "x-forwarded-host": "memory.example.test" } },
    { url: "http://memory.example.test/api/mcp" },
  ])("rejects untrusted host/origin before initialization: %j", async (options) => {
    const { application, api } = setup();
    expect((await application.fetch(request(undefined, options))).status).toBe(403);
    expect(api.requests).toHaveLength(0);
  });
  it("allows non-browser clients, explicit origins, and ignores forwarded authority", async () => {
    const { application } = setup({ ...validHttpEnvironment, MCP_ALLOWED_ORIGINS: "https://client.example.test" });
    for (const headers of [{}, { origin: "https://client.example.test" }, { "x-forwarded-host": "evil.example.test", host: "MEMORY.EXAMPLE.TEST" }]) {
      const response = await application.fetch(request(undefined, { headers }));
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
  it("rejects query parameters without echoing supplied credentials", async () => {
    const { application, api } = setup();
    const response = await application.fetch(request(undefined, { url: "https://memory.example.test/api/mcp?token=" + FAKE_BEARER_TOKEN }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(FAKE_BEARER_TOKEN);
    expect(api.requests).toHaveLength(0);
  });
  it.each([
    { headers: { "content-length": String(HTTP_REQUEST_LIMIT_BYTES + 1) } },
    { raw: "x".repeat(HTTP_REQUEST_LIMIT_BYTES + 1) },
    { raw: "x".repeat(HTTP_REQUEST_LIMIT_BYTES + 1), headers: { "content-length": "1" } },
  ])("rejects oversized bodies before parsing or initialization: %j", async (options) => {
    const { application, api } = setup();
    const response = await application.fetch(request(undefined, options));
    expect(response.status).toBe(413);
    expect(api.requests).toHaveLength(0);
  });
  it("accepts a bounded multi-chunk body and rejects chunked overflow", async () => {
    const valid = setup();
    const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const bounded = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 12)); controller.enqueue(bytes.slice(12)); controller.close(); } });
    const validRequest = new Request("https://memory.example.test/api/mcp", { method: "POST", headers: { authorization: "Bearer " + FAKE_BEARER_TOKEN, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: bounded, duplex: "half" } as RequestInit);
    expect((await valid.application.fetch(validRequest)).status).toBe(200);
    const { application, api } = setup();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(HTTP_REQUEST_LIMIT_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    const input = new Request("https://memory.example.test/api/mcp", { method: "POST", headers: { authorization: "Bearer " + FAKE_BEARER_TOKEN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect((await application.fetch(input)).status).toBe(413);
    expect(api.requests).toHaveLength(0);
  });
  it("caps buffered output and cleans up instead of returning an oversized response", async () => {
    const close = vi.spyOn(McpServer.prototype, "close");
    const { application } = setup(validHttpEnvironment, inMemoryProjects([{ ...project, description: "x".repeat(HTTP_RESPONSE_LIMIT_BYTES) }]));
    const response = await application.fetch(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: { limit: 1 } } }));
    expect(response.status).toBe(503);
    expect((await response.text()).length).toBeLessThan(1000);
    expect(close).toHaveBeenCalled();
  });
  it("maps startup schema failure to service unavailability rather than a bearer challenge", async () => {
    const { application, api, logs } = setup();
    delete api.fixtures.schemas.projects.properties.Name;
    const response = await application.fetch(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.text()).toContain("DEPENDENCY_UNAVAILABLE");
    expect(logs.join("")).toContain("SCHEMA_DRIFT");
  });
  it.each([{ "content-type": "text/plain" }, { "content-encoding": "gzip" }])("rejects unsupported body formats %j", async (headers) => {
    const { application, api } = setup();
    expect((await application.fetch(request(undefined, { headers }))).status).toBe(415);
    expect(api.requests).toHaveLength(0);
  });
  it("bounds a stalled body and cancels its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { application, api } = setup();
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const pending = application.fetch(new Request("https://memory.example.test/api/mcp", { method: "POST", headers: { authorization: "Bearer " + FAKE_BEARER_TOKEN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    await vi.advanceTimersByTimeAsync(HTTP_REQUEST_TIMEOUT_MS);
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(api.requests).toHaveLength(0);
  });
  it("closes the server when the caller disconnects during a tool call", async () => {
    const close = vi.spyOn(McpServer.prototype, "close");
    let entered!: () => void;
    const invoked = new Promise<void>((resolve) => { entered = resolve; });
    const { application } = setup(validHttpEnvironment, { list: () => { entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const original = request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects" } });
    const pending = application.fetch(new Request(original, { signal: controller.signal }));
    await invoked;
    controller.abort();
    expect((await pending).status).toBe(504);
    expect(close).toHaveBeenCalled();
  });
});

describe("liveness and readiness", () => {
  it.each([
    ["credentials", 401, "unauthorized", "UNAUTHORIZED", "retrieve_database", "http_response"],
    ["permissions", 403, "restricted_resource", "FORBIDDEN", "retrieve_data_source", "http_response"],
    ["unavailable database", 404, "object_not_found", "NOT_FOUND", "retrieve_database", "http_response"],
    ["API validation", 400, "validation_error", "VALIDATION_ERROR", "retrieve_database", "http_response"],
    ["rate limit", 429, "rate_limited", "RATE_LIMITED", "retrieve_database", "http_response"],
    ["upstream outage", 503, "service_unavailable", "DEPENDENCY_UNAVAILABLE", "retrieve_data_source", "http_response"],
    ["DNS failure", 0, "ENOTFOUND", "DEPENDENCY_UNAVAILABLE", "retrieve_database", "network"],
    ["malformed JSON", 200, "invalid_json", "DEPENDENCY_UNAVAILABLE", "retrieve_data_source", "invalid_response"],
  ] as const)("diagnoses %s before readiness error conversion without leaking request data", async (_scenario, status, upstreamCode, code, operation, category) => {
    const api = createFixtureApi();
    const logs: string[] = [];
    const target = operation === "retrieve_database" ? "/databases/" + databaseIds.knowledge : "/data_sources/" + sourceIds.knowledge;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.method ?? "GET").toBe("GET");
      if (!url.endsWith(target)) return api.fetch(input, init);
      if (status === 0) throw new TypeError("private " + FAKE_NOTION_TOKEN, { cause: Object.assign(new Error("private DNS details"), { code: upstreamCode }) });
      if (status === 200) return new Response("private invalid JSON " + FAKE_BEARER_TOKEN, { status });
      return Response.json({ object: "error", status, code: upstreamCode, message: "private " + FAKE_NOTION_TOKEN }, {
        status, headers: { "retry-after": "0", "x-private": FAKE_BEARER_TOKEN },
      });
    });
    const application = createHttpApplication(() => validHttpEnvironment, { destination: { write(line: string) { logs.push(line); } } });
    const response = await application.fetch(request(undefined, { path: "/api/ready", method: "GET" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
    const records = logs.map((line) => JSON.parse(line));
    const failure = records.find((record) => record.msg === "notion_metadata_failed");
    expect(failure).toMatchObject({ dependency: "notion", database: "knowledge", operation, code, category });
    if (category === "http_response") expect(failure).toMatchObject({ upstreamStatus: status, upstreamCode });
    if (category === "network") expect(failure.networkCode).toBe("ENOTFOUND");
    expect(records.find((record) => record.msg === "application_initialization_failed")).toMatchObject({ phase: "notion_schema", error: { code } });
    expect(records.find((record) => record.msg === "http_initialization_failed")).toMatchObject({ error: { code } });
    expect(records.find((record) => record.msg === "http_request_failed")).toMatchObject({ error: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(failure.correlationId).toBe(response.headers.get("x-correlation-id"));
    expect(Object.keys(failure).sort()).toEqual([
      "category", "code", "correlationId", "database", "dependency", "level", "msg", "operation", "service", "time",
      ...(category === "http_response" ? ["upstreamCode", "upstreamStatus"] : []), ...(category === "network" ? ["networkCode"] : []),
    ].sort());
    for (const forbidden of [FAKE_NOTION_TOKEN, FAKE_BEARER_TOKEN, FAKE_BEARER_SHA256, "private", ...Object.values(databaseIds), ...Object.values(sourceIds)]) {
      expect(logs.join("")).not.toContain(forbidden);
    }
  });
  it("answers health without environment validation or Notion reads", async () => {
    const environment = vi.fn(() => { throw new Error("Must not read configuration"); });
    const application = createHttpApplication(environment);
    expect(await (await application.fetch(new Request("https://memory.example.test/api/health"))).json()).toEqual({ status: "ok" });
    expect(environment).not.toHaveBeenCalled();
  });
  it("authenticates readiness, warms once, and reuses initialization across routes", async () => {
    const { application, api } = setup();
    const unauthenticated = new Request("https://memory.example.test/api/ready");
    expect((await application.fetch(unauthenticated)).status).toBe(401);
    expect(api.requests).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      const response = await application.fetch(request(undefined, { path: "/api/ready", method: "GET" }));
      expect(await response.json()).toEqual({ status: "ready" });
    }
    expect((await application.fetch(request())).status).toBe(200);
    expect(api.requests).toHaveLength(6);
  });
  it("reports not_ready for bad configuration and backs off failed initialization", async () => {
    vi.useFakeTimers();
    const { application: invalid } = setup({});
    expect(await (await invalid.fetch(request(undefined, { path: "/api/ready", method: "GET" }))).json()).toEqual({ status: "not_ready" });
    const { application, api, logs } = setup();
    const original = api.fixtures.schemas.projects.properties.Name!;
    delete api.fixtures.schemas.projects.properties.Name;
    expect((await application.fetch(request(undefined, { path: "/api/ready", method: "GET" }))).status).toBe(503);
    api.fixtures.schemas.projects.properties.Name = original;
    expect((await application.fetch(request(undefined, { path: "/api/ready", method: "GET" }))).status).toBe(503);
    expect(api.requests).toHaveLength(6);
    expect(logs.map((line) => JSON.parse(line)).find((record) => record.msg === "application_initialization_failed")).toMatchObject({
      phase: "notion_schema", error: { code: "SCHEMA_DRIFT", issues: [{ database: "projects", property: "Name", reason: "MISSING_PROPERTY" }] },
    });
    expect(logs.map((line) => JSON.parse(line)).filter((record) => record.msg === "http_initialization_cooldown")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HTTP_INITIALIZATION_RETRY_MS);
    expect((await application.fetch(request(undefined, { path: "/api/ready", method: "GET" }))).status).toBe(200);
    expect(api.requests).toHaveLength(12);
  });
});
