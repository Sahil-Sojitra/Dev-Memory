import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { initializeApplication } from "../app.ts";
import type { ApplicationOptions } from "../app.ts";
import { loadConfig } from "../config/environment.ts";
import type { AppConfig, Environment } from "../config/environment.ts";
import { ConfigurationError, DomainError, mapError } from "../domain/errors.ts";
import type { ErrorCode } from "../domain/errors.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import { createLogger } from "../observability/logger.ts";
import { createRedactor } from "../observability/redaction.ts";
import { createBearerVerifier, unauthorizedResponse } from "./bearer.ts";

export const HTTP_REQUEST_LIMIT_BYTES = 64 * 1024;
export const HTTP_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
export const HTTP_REQUEST_TIMEOUT_MS = 45_000;
export const HTTP_INITIALIZATION_RETRY_MS = 30_000;
type HttpConfig = Extract<AppConfig, { transport: "http" }>;
type Application = Awaited<ReturnType<typeof initializeApplication>>;

function errorResponse(code: ErrorCode, status?: number): Response {
  const safe = mapError(new DomainError(code), getCorrelationId() ?? "unavailable");
  return Response.json({ error: { code: safe.code, message: safe.message, correlationId: safe.correlationId } }, {
    status: status ?? safe.httpStatus,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function checkAuthority(request: Request, config: HttpConfig): void {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (url.protocol !== "https:" || !config.http.allowedHosts.includes(url.host)
    || (host !== null && !config.http.allowedHosts.includes(host.toLowerCase()))) throw new DomainError("FORBIDDEN");
  const origin = request.headers.get("origin");
  if (origin !== null && !config.http.allowedOrigins.includes(origin)) throw new DomainError("FORBIDDEN");
  // No forwarded host headers or credential-bearing query parameters are trusted.
  if (url.search || url.hash || url.username || url.password) throw new DomainError("VALIDATION_ERROR");
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DomainError("TIMEOUT"));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal, overflow: ErrorCode = "PAYLOAD_TOO_LARGE"): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await waitFor(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) throw new DomainError(overflow);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    // Do not await a hostile body's cancel implementation, which can itself stall.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function redactProtocolErrors(bytes: Uint8Array<ArrayBuffer>, contentType: string, redact: ReturnType<typeof createRedactor>): Uint8Array<ArrayBuffer> {
  function isErrorFrame(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    if ("error" in value) return true;
    return "result" in value && typeof value.result === "object" && value.result !== null
      && "isError" in value.result && value.result.isError === true;
  }
  function frame(text: string): string {
    try {
      const value: unknown = JSON.parse(text);
      const frames: unknown[] = Array.isArray(value) ? value : [value];
      if (!frames.some(isErrorFrame)) return text;
      const safe = frames.map((item) => isErrorFrame(item) ? redact.value(item) : item);
      return JSON.stringify(Array.isArray(value) ? safe : safe[0]);
    } catch { return text; }
  }
  const text = new TextDecoder().decode(bytes);
  // This only decorates SDK-generated errors. Framing, classification and
  // dispatch remain SDK-owned; successful project data is left unchanged.
  const safe = contentType.includes("text/event-stream")
    ? text.split("\n").map((line) => line.startsWith("data:") ? "data:" + frame(line.slice(5)) : line).join("\n")
    : contentType.includes("application/json") ? frame(text) : text;
  return new TextEncoder().encode(safe);
}

// A warm cache of validated application services, never a client session store.
// Request authentication is revalidated against process configuration each time.
export function createHttpApplication(environment: () => Environment = () => process.env, options: ApplicationOptions = {}) {
  let application: Promise<Application> | undefined;
  let retryAfter = 0;
  function initialized(snapshot: Environment): Promise<Application> {
    if (!application) {
      if (Date.now() < retryAfter) return Promise.reject(new DomainError("DEPENDENCY_UNAVAILABLE"));
      const attempt = initializeApplication(snapshot, options);
      application = attempt;
      void attempt.catch(() => {
        if (application === attempt) {
          application = undefined;
          retryAfter = Date.now() + HTTP_INITIALIZATION_RETRY_MS;
        }
      });
    }
    return application;
  }

  async function fetchRequest(request: Request): Promise<Response> {
    return withCorrelationId(async () => {
      const path = new URL(request.url).pathname;
      if (path === "/api/health") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
        return request.method === "HEAD" ? new Response(null, { headers: responseHeaders() })
          : Response.json({ status: "ok" }, { headers: responseHeaders() });
      }
      if (path !== "/api/mcp" && path !== "/api/ready") return errorResponse("NOT_FOUND");
      let config: HttpConfig;
      let snapshot: Environment;
      try {
        snapshot = Object.freeze({ ...environment() });
        const loaded = loadConfig(snapshot);
        if (loaded.transport !== "http") throw new ConfigurationError(["MCP_TRANSPORT"]);
        config = loaded;
      } catch (error) {
        const logger = createLogger({ environment: {}, ...(options.destination ? { destination: options.destination } : {}) });
        logger.error("http_configuration_failed", {
          error: mapError(error, getCorrelationId() ?? "unavailable"),
          ...(error instanceof ConfigurationError ? { invalidFields: error.invalidFields } : {}),
        });
        return path === "/api/ready" ? notReady() : errorResponse("CONFIGURATION_ERROR", 503);
      }
      const logger = createLogger({ environment: snapshot, level: config.logLevel, ...(options.destination ? { destination: options.destination } : {}) });
      // No JSON parsing, body reads, application initialization or SDK dispatch
      // may run before this check. Never log Request, headers, body or raw errors.
      if (!createBearerVerifier(config.http)(request.headers)) {
        logger.warn("http_authentication_rejected");
        return unauthorizedResponse();
      }
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      request.signal.addEventListener("abort", disconnect, { once: true });
      if (request.signal.aborted) controller.abort();
      const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
      timer.unref();
      async function readyServices(): Promise<Application> {
        try { return await waitFor(initialized(snapshot), controller.signal); }
        catch (error) {
          logger.error("http_initialization_failed", { error: mapError(error, getCorrelationId() ?? "unavailable") });
          throw new DomainError(error instanceof DomainError && error.code === "TIMEOUT" ? "TIMEOUT" : "DEPENDENCY_UNAVAILABLE");
        }
      }
      try {
        checkAuthority(request, config);
        if (path === "/api/ready") {
          if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
          await readyServices();
          return request.method === "HEAD" ? new Response(null, { headers: responseHeaders() })
            : Response.json({ status: "ready" }, { headers: responseHeaders() });
        }
        if (request.method !== "POST") return methodNotAllowed("POST");
        const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const encoding = request.headers.get("content-encoding");
        if (contentType !== "application/json" || (encoding !== null && encoding !== "identity")) throw new DomainError("UNSUPPORTED_MEDIA_TYPE");
        const length = request.headers.get("content-length");
        if (length !== null) {
          if (!/^\d+$/.test(length)) throw new DomainError("VALIDATION_ERROR");
          if (Number(length) > HTTP_REQUEST_LIMIT_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE");
        }
        const body = await readBounded(request.body, HTTP_REQUEST_LIMIT_BYTES, controller.signal);
        const services = await readyServices();
        const headers = new Headers(request.headers);
        for (const name of ["authorization", "proxy-authorization", "cookie", "content-length", "forwarded", "x-forwarded-host"]) headers.delete(name);
        const sanitized = new Request(request.url, { method: "POST", headers, body, signal: controller.signal });
        const servers: McpServer[] = [];
        const handler = createMcpHandler(() => {
          const server = services.createServer();
          servers.push(server);
          return server;
        }, {
          legacy: "stateless", responseMode: "json", maxSubscriptions: 0,
          maxRequestBodySize: HTTP_REQUEST_LIMIT_BYTES, keepAliveMs: 0,
          onerror: (error) => logger.warn("http_mcp_error", { error: mapError(error, getCorrelationId() ?? "unavailable") }),
        });
        try {
          const result = await waitFor(handler.fetch(sanitized), controller.signal);
          // Both modern JSON and finite legacy SSE are drained before teardown.
          // No infinite stream or invocation-owned transport outlives the response.
          const raw = await readBounded(result.body, HTTP_RESPONSE_LIMIT_BYTES, controller.signal, "DEPENDENCY_UNAVAILABLE");
          // Only request-scoped redaction sees the presented credential. It is
          // never cached, put in server configuration, or passed to SDK context.
          const redact = createRedactor(snapshot, [request.headers.get("authorization")?.slice(7) ?? ""]);
          const bytes = redactProtocolErrors(raw, result.headers.get("content-type") ?? "", redact);
          if (bytes.byteLength > HTTP_RESPONSE_LIMIT_BYTES) throw new DomainError("DEPENDENCY_UNAVAILABLE");
          const response = new Response(bytes.length ? bytes : null, { status: result.status, headers: result.headers });
          for (const [key, value] of Object.entries(responseHeaders())) response.headers.set(key, value);
          for (const name of ["mcp-session-id", "connection", "keep-alive", "transfer-encoding", "trailer", "upgrade", "content-length"]) response.headers.delete(name);
          logger.info("http_mcp_completed", { status: result.status });
          return response;
        } finally {
          controller.abort();
          await handler.close();
          await Promise.allSettled(servers.map((server) => server.close()));
        }
      } catch (error) {
        logger.error("http_request_failed", { error: mapError(error, getCorrelationId() ?? "unavailable") });
        if (path === "/api/ready") return notReady();
        return error instanceof DomainError ? errorResponse(error.code) : errorResponse("INTERNAL_ERROR");
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", disconnect);
      }
    });
  }
  return Object.freeze({ fetch: fetchRequest });
}

function responseHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Correlation-ID": getCorrelationId() ?? "unavailable" };
}
function methodNotAllowed(allow: string): Response {
  const response = errorResponse("METHOD_NOT_ALLOWED");
  response.headers.set("Allow", allow);
  return response;
}
function notReady(): Response {
  return Response.json({ status: "not_ready" }, { status: 503, headers: responseHeaders() });
}
