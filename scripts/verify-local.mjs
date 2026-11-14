import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { loadConfig } from "../src/config/environment.ts";
import { ConfigurationError, DomainError, ERROR_CATALOG, mapError } from "../src/domain/errors.ts";
import { createCorrelationId } from "../src/observability/context.ts";

// Live read-only acceptance probe: no preloads, .env loading, or record printing.
const results = [];
let child;
let closed;
let stderr = "";
let buffer = "";
let frames = 0;
let invalidFrames = 0;
const pending = new Map();
try {
  const config = loadConfig(process.env);
  if (config.transport !== "stdio") throw new ConfigurationError(["MCP_TRANSPORT"]);
  child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  closed = once(child, "exit");
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let index; (index = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        frames++;
        const waiter = pending.get(message.id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
      } catch {
        invalidFrames++;
        for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DomainError("INTERNAL_ERROR")); }
        pending.clear();
      }
    }
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DomainError("DEPENDENCY_UNAVAILABLE")); }
    pending.clear();
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new DomainError("TIMEOUT")); }, 45_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "devmemory-live-verification", version: "1.0.0" } });
  assert.equal(initialized.result?.serverInfo?.name, "devmemory");
  results.push({ check: "initialize", status: "PASS" });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ["list_projects", "get_project_context", "get_knowledge_entry", "capture_knowledge"]);
  results.push({ check: "tool_discovery", status: "PASS" });
  async function call(input) {
    const response = await request("tools/call", { name: "list_projects", arguments: input });
    if (response.error || response.result?.isError) {
      const code = response.result?.structuredContent?.error?.code;
      throw new DomainError(typeof code === "string" && Object.hasOwn(ERROR_CATALOG, code) ? code : "DEPENDENCY_UNAVAILABLE");
    }
    const value = response.result?.structuredContent;
    assert.ok(value && Array.isArray(value.projects) && typeof value.hasMore === "boolean");
    assert.equal(value.hasMore, typeof value.nextCursor === "string");
    for (const project of value.projects) {
      assert.ok(typeof project.id === "string" && typeof project.name === "string" && typeof project.url === "string" && Array.isArray(project.primaryStack));
      assert.ok(Object.keys(project).every((key) => ["id", "name", "url", "description", "repositoryUrl", "status", "primaryStack"].includes(key)));
    }
    return value;
  }
  const first = await call({ limit: 1 });
  results.push({ check: "live_project_mapping", status: first.projects.length ? "PASS" : "BLOCKED", count: first.projects.length,
    ...(!first.projects.length ? { reason: "Projects data source returned no records." } : {}) });
  const sample = first.projects[0];
  if (sample?.name) {
    const needle = sample.name.slice(0, 200).split("").map((char, index) => index % 2 ? char.toLowerCase() : char.toUpperCase()).join("");
    const page = await call({ limit: 1, nameContains: needle });
    assert.ok(page.projects.some((project) => project.id === sample.id));
    results.push({ check: "mixed_case_name_filter", status: "PASS" });
  } else results.push({ check: "mixed_case_name_filter", status: "BLOCKED", reason: "No named project available." });
  const status = sample?.status ?? "Active";
  const filtered = await call({ limit: 1, status });
  assert.ok(filtered.projects.every((project) => project.status === status));
  results.push({ check: "exact_status_filter", status: filtered.projects.length ? "PASS" : "BLOCKED", count: filtered.projects.length });
  if (first.hasMore) {
    const next = await call({ limit: 1, cursor: first.nextCursor });
    assert.ok(next.projects.length > 0 && next.projects[0].id !== sample?.id);
    results.push({ check: "live_pagination", status: "PASS", count: next.projects.length });
  } else results.push({ check: "live_pagination", status: "BLOCKED", reason: "Insufficient records for a second page." });
  child.stdin.end();
  const [exitCode] = await closed;
  assert.equal(exitCode, 0);
  assert.equal(buffer, "");
  assert.equal(invalidFrames, 0);
  const logs = stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(logs.some((line) => line.msg === "list_projects_completed"));
  results.push({ check: "stdout_protocol_stderr_logs", status: "PASS", protocolFrames: frames });
  const statusSummary = results.every((result) => result.status === "PASS") ? "PASS" : "BLOCKED";
  process.stdout.write(JSON.stringify({ status: statusSummary, results }) + "\n");
  process.exitCode = statusSummary === "PASS" ? 0 : 2;
} catch (error) {
  const blocked = error instanceof ConfigurationError;
  process.stderr.write(JSON.stringify({ status: blocked ? "BLOCKED" : "FAIL", error: mapError(error, createCorrelationId()), results,
    ...(blocked ? { invalidFields: error.invalidFields, action: "Supply process environment variables; .env is never loaded." } : {}),
  }) + "\n");
  process.exitCode = blocked ? 2 : 1;
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  if (child && child.exitCode === null) {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}
