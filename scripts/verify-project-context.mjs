import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { loadConfig } from "../src/config/environment.ts";
import { ConfigurationError, DomainError, ERROR_CATALOG } from "../src/domain/errors.ts";
import { NOTION_SCHEMA } from "../src/domain/schema-map.ts";

// Run with Node --env-file=.env. No file loading, raw record output or Notion writes.
// Reuses verify-local.mjs's JSON-RPC stdio protocol against the production entry point.
const checks = new Map();
const required = ["initialize", "tool_discovery", "list_projects", "project_details", "associated_subprojects",
  "counts_arithmetic", "counts_against_entries", "recent_entries", "setup_entries", "needs_review_entries",
  "recent_ordering", "setup_ordering", "needs_review_ordering", "independent_limits", "valid_subproject",
  "unrelated_subproject", "invalid_project", "completeness_metadata", "observed_truncation", "stdio_hygiene"];
const record = (check, status, evidence) => checks.set(check, { check, status, evidence });
// Data prerequisites are SKIP; exhausted execution budgets remain BLOCKED.
const unavailable = (...scans) => scans.some((scan) => scan.reason === "request_budget") ? "BLOCKED" : "SKIP";
const failureStatus = (error) => error instanceof ConfigurationError || (error instanceof DomainError &&
  ["UNAUTHORIZED", "FORBIDDEN", "RATE_LIMITED", "DEPENDENCY_UNAVAILABLE", "TIMEOUT", "REQUEST_BUDGET_EXCEEDED", "SCHEMA_DRIFT"].includes(error.code)) ? "BLOCKED" : "FAIL";
for (const check of required) record(check, "BLOCKED", "Not reached.");
let child;
let exited;
let buffer = "";
let invalidFrames = 0;
let logLines = 0;
let logBuffer = "";
let sequence = 0;
const pending = new Map();
const sections = ["subprojects", "knowledgeCounts", "recentKnowledge", "setupRunbooks", "needsReview"];
const lists = ["recentKnowledge", "setupRunbooks", "needsReview"];
const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0);
const ids = (items) => items.map((item) => item.id).sort();
function validateContext(value, projectId, limit) {
  assert.equal(value.project.id, projectId);
  assert.equal(typeof value.project.name, "string");
  assert.ok(URL.canParse(value.project.url));
  assert.ok(Array.isArray(value.project.primaryStack));
  assert.ok(Array.isArray(value.subprojects));
  assert.equal(new Set(ids(value.subprojects)).size, value.subprojects.length);
  for (const subproject of value.subprojects) assert.ok(subproject.projectIds.includes(projectId));
  for (const field of lists) {
    assert.ok(Array.isArray(value[field]));
    assert.ok(value[field].length <= limit);
    assert.equal(new Set(ids(value[field])).size, value[field].length);
    for (const entry of value[field]) {
      assert.equal(typeof entry.name, "string");
      assert.ok(URL.canParse(entry.url));
      assert.ok(Number.isFinite(Date.parse(entry.lastUpdated)));
    }
    for (let i = 1; i < value[field].length; i++) {
      assert.ok(Date.parse(value[field][i - 1].lastUpdated) >= Date.parse(value[field][i].lastUpdated));
    }
  }
  assert.ok(value.setupRunbooks.every((entry) => entry.type === "Setup / Runbook"));
  assert.ok(value.needsReview.every((entry) => entry.verification === "Needs Review"));
  const counts = value.knowledgeCounts;
  assert.ok(Number.isInteger(counts.total) && counts.total >= 0 && counts.total <= 500);
  for (const [field, options] of [["byType", NOTION_SCHEMA.knowledge.type.options], ["byVerification", NOTION_SCHEMA.knowledge.verification.options]]) {
    assert.deepEqual(Object.keys(counts[field]).sort(), [...options, "Unspecified"].sort());
    assert.ok(Object.values(counts[field]).every((count) => Number.isInteger(count) && count >= 0));
    assert.equal(sum(counts[field]), counts.total);
  }
  for (const field of sections) {
    const scan = value.scan[field];
    assert.ok(Number.isInteger(scan.scanned) && scan.scanned >= 0 && scan.scanned <= 500);
    assert.equal(typeof scan.complete, "boolean");
    assert.equal(scan.truncated, !scan.complete);
    assert.equal(scan.complete, scan.reason === null);
    if (!scan.complete) assert.ok(["scan_limit", "request_budget", "result_limit"].includes(scan.reason));
    if (scan.reason === "scan_limit") assert.equal(scan.scanned, 500);
    if (scan.reason === "result_limit") {
      assert.ok(lists.includes(field));
      assert.equal(scan.scanned, limit);
    }
    const length = field === "knowledgeCounts" ? counts.total : value[field].length;
    assert.equal(scan.scanned, length);
  }
  assert.equal(value.requestBudget.maxRequests, 20);
  assert.equal(value.requestBudget.maxDurationMs, 30_000);
  assert.ok(Number.isInteger(value.requestBudget.usedRequests));
  assert.ok(value.requestBudget.usedRequests >= 0 && value.requestBudget.usedRequests <= 20);
}
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new DomainError("TIMEOUT")); }, 45_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
      if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(new DomainError("DEPENDENCY_UNAVAILABLE")); }
    });
  });
}
async function call(name, args, expectedError) {
  assert.ok(["list_projects", "get_project_context"].includes(name));
  const response = await request("tools/call", { name, arguments: args });
  const result = response.result;
  assert.ok(!response.error && result);
  if (expectedError) {
    const safe = result.structuredContent?.error;
    assert.equal(result.isError, true);
    assert.equal(safe?.code, expectedError);
    assert.equal(safe.message, ERROR_CATALOG[expectedError].message);
    assert.equal(safe.httpStatus, ERROR_CATALOG[expectedError].httpStatus);
    assert.equal(safe.retryable, false);
    assert.equal(typeof safe.correlationId, "string");
    assert.ok(Object.keys(safe).every((key) => ["code", "message", "httpStatus", "retryable", "correlationId", "database"].includes(key)));
    return;
  }
  if (result.isError) {
    const code = result.structuredContent?.error?.code;
    throw new DomainError(Object.hasOwn(ERROR_CATALOG, code ?? "") ? code : "DEPENDENCY_UNAVAILABLE");
  }
  const value = result.structuredContent;
  assert.ok(value);
  assert.deepEqual(JSON.parse(result.content.find((part) => part.type === "text").text), value);
  return value;
}
async function check(name, operation) {
  try { await operation(); }
  catch (error) {
    record(name, failureStatus(error), error instanceof DomainError ? error.code : "Response assertion failed; raw details suppressed.");
  }
}
let active = "initialize";
try {
  if (process.version !== "v24.22.1") throw new ConfigurationError(["NODE_VERSION"]);
  loadConfig({ ...process.env, MCP_TRANSPORT: "stdio" });
  child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(), env: { ...process.env, MCP_TRANSPORT: "stdio" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Observe rejection immediately, including spawn failures. Never emit raw errors/logs.
  void exited.catch(() => {});
  child.on("error", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DomainError("DEPENDENCY_UNAVAILABLE")); }
    pending.clear();
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DomainError("DEPENDENCY_UNAVAILABLE")); }
    pending.clear();
  });
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        assert.equal(response.jsonrpc, "2.0");
        const waiter = pending.get(response.id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(response.id); waiter.resolve(response); }
      } catch { invalidFrames++; }
    }
  });
  child.stderr.on("data", (chunk) => {
    logBuffer += chunk.toString();
    for (let end; (end = logBuffer.indexOf("\n")) >= 0;) {
      try { JSON.parse(logBuffer.slice(0, end)); logLines++; } catch { invalidFrames++; }
      logBuffer = logBuffer.slice(end + 1);
    }
  });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "devmemory-context-acceptance", version: "1.0.0" } });
  assert.equal(initialized.result?.serverInfo?.name, "devmemory");
  record(active, "PASS", "Production stdio server initialized.");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  active = "tool_discovery";
  const tools = await request("tools/list");
  assert.deepEqual(tools.result?.tools?.map((tool) => tool.name).sort(), ["get_knowledge_entry", "get_project_context", "list_projects"]);
  record(active, "PASS", "All three implemented read-only tools discovered.");
  active = "list_projects";
  const projects = [];
  const cursors = new Set();
  let cursor;
  let discoveryComplete = false;
  for (let page = 0; page < 3; page++) {
    const value = await call("list_projects", { limit: 100, ...(cursor ? { cursor } : {}) });
    assert.ok(Array.isArray(value.projects));
    projects.push(...value.projects);
    if (!value.hasMore) { discoveryComplete = true; break; }
    assert.ok(value.nextCursor && !cursors.has(value.nextCursor));
    cursors.add(value.nextCursor); cursor = value.nextCursor;
  }
  record(active, "PASS", { returned: projects.length, discoveryComplete, pageCap: 3 });
  if (!projects.length) {
    for (const name of required.slice(3, -1)) record(name, "SKIP", "No project records returned in bounded discovery; no data was created.");
  } else {
    active = "project_details";
    // Inspect at most ten projects to find suitable existing subproject/knowledge fixtures.
    const contexts = [];
    for (const project of projects.slice(0, 10)) {
      const context = await call("get_project_context", { projectId: project.id, recentLimit: 10 });
      validateContext(context, project.id, 10);
      assert.deepEqual(context.project, project);
      contexts.push(context);
    }
    const selected = [...contexts].sort((a, b) =>
      (b.knowledgeCounts.total + b.subprojects.length) - (a.knowledgeCounts.total + a.subprojects.length))[0];
    const projectId = selected.project.id;
    record("project_details", "PASS", { comparedWithListProjects: true, projectsInspected: contexts.length });
    record("associated_subprojects", selected.scan.subprojects.complete && selected.subprojects.length ? "PASS" : unavailable(selected.scan.subprojects), {
      returned: selected.subprojects.length, allReturnedRelationsMatch: true, scan: selected.scan.subprojects,
      scope: "MCP mapping and completeness; no independent raw Notion oracle",
    });
    record("counts_arithmetic", "PASS", { total: selected.knowledgeCounts.total, byType: selected.knowledgeCounts.byType,
      byVerification: selected.knowledgeCounts.byVerification, lowerBounds: !selected.scan.knowledgeCounts.complete });
    record("completeness_metadata", "PASS", { scan: selected.scan, requestBudget: selected.requestBudget });
    for (const [field, presence, ordering] of [["recentKnowledge", "recent_entries", "recent_ordering"], ["setupRunbooks", "setup_entries", "setup_ordering"], ["needsReview", "needs_review_entries", "needs_review_ordering"]]) {
      record(presence, selected[field].length ? "PASS" : unavailable(selected.scan[field]), { returned: selected[field].length, scan: selected.scan[field] });
      record(ordering, selected[field].length >= 2 ? "PASS" : unavailable(selected.scan[field]), {
        returned: selected[field].length, reason: "At least two entries are required for live ordering evidence; all returned ordering assertions remain enforced.",
      });
    }
    active = "independent_limits";
    const small = await call("get_project_context", { projectId, recentLimit: 1 });
    validateContext(small, projectId, 1);
    // Missing data must never hide a failed assertion for a list with sufficient data.
    for (const field of lists) {
      if (selected[field].length > 1) {
        assert.equal(small[field].length, 1);
        assert.equal(small.scan[field].truncated, true);
        assert.equal(small.scan[field].reason, "result_limit");
      }
    }
    record("observed_truncation", sections.some((field) => small.scan[field].truncated) ? "PASS" : "SKIP", {
      scan: small.scan, reason: "No artificial truncation or test records introduced; SKIP means no truncation condition was observed.",
    });
    record(active, lists.every((field) => selected[field].length > 1) ? "PASS" : unavailable(...lists.map((field) => selected.scan[field]), ...lists.map((field) => small.scan[field])), {
      reason: "Limits 10 and 1 enforced separately for every returned list; demonstrating all three limits requires two matching records per list.",
      insufficientLists: lists.filter((field) => selected[field].length < 2),
    });
    await check("counts_against_entries", async () => {
      const wide = await call("get_project_context", { projectId, recentLimit: 25 });
      validateContext(wide, projectId, 25);
      if (!wide.scan.knowledgeCounts.complete || !wide.scan.recentKnowledge.complete) {
        record("counts_against_entries", unavailable(wide.scan.knowledgeCounts, wide.scan.recentKnowledge),
          "Cannot recount from complete MCP entries: bounded count scan or maximum 25-entry recent list is incomplete. No raw Notion oracle used."); return;
      }
      const counts = wide.knowledgeCounts;
      assert.equal(wide.recentKnowledge.length, counts.total);
      for (const [field, property] of [["byType", "type"], ["byVerification", "verification"]]) {
        for (const [category, count] of Object.entries(counts[field])) {
          assert.equal(wide.recentKnowledge.filter((entry) => (entry[property] ?? "Unspecified") === category).length, count);
        }
      }
      for (const [field, predicate] of [["setupRunbooks", (entry) => entry.type === "Setup / Runbook"], ["needsReview", (entry) => entry.verification === "Needs Review"]]) {
        assert.ok(wide.scan[field].complete);
        assert.deepEqual(ids(wide[field]), ids(wide.recentKnowledge.filter(predicate)));
      }
      record("counts_against_entries", counts.total ? "PASS" : "SKIP", { independentlyRecountedFromMcpEntries: counts.total, rawNotionOracle: false });
    });
    await check("valid_subproject", async () => {
      const parent = contexts.find((context) => context.subprojects.length);
      if (!parent) { record("valid_subproject", unavailable(...contexts.map((context) => context.scan.subprojects)), "No associated subproject found in the bounded discovery."); return; }
      const subprojectId = parent.subprojects[0].id;
      const scoped = await call("get_project_context", { projectId: parent.project.id, subprojectId, recentLimit: 10 });
      validateContext(scoped, parent.project.id, 10);
      assert.equal(scoped.subprojectId, subprojectId);
      if (parent.scan.subprojects.complete && scoped.scan.subprojects.complete) assert.deepEqual(ids(scoped.subprojects), ids(parent.subprojects));
      if (parent.scan.knowledgeCounts.complete) assert.ok(scoped.knowledgeCounts.total <= parent.knowledgeCounts.total);
      record("valid_subproject", "PASS", { accepted: true, scopedTotal: scoped.knowledgeCounts.total, scan: scoped.scan,
        scope: "Selection accepted and response validated; raw entry relations are not exposed by MCP." });
    });
    await check("unrelated_subproject", async () => {
      for (const parent of contexts) {
        const unrelated = contexts.flatMap((context) => context.subprojects).find((item) => !item.projectIds.includes(parent.project.id));
        if (unrelated) {
          await call("get_project_context", { projectId: parent.project.id, subprojectId: unrelated.id, recentLimit: 10 }, "INVALID_RELATION");
          record("unrelated_subproject", "PASS", "Existing unrelated subproject rejected with sanitized INVALID_RELATION."); return;
        }
      }
      record("unrelated_subproject", unavailable(...contexts.map((context) => context.scan.subprojects)), "No unrelated subproject found within three project pages / ten contexts; existence outside this bound is unverified.");
    });
    await check("invalid_project", async () => {
      await call("get_project_context", { projectId: randomUUID(), recentLimit: 10 }, "NOT_FOUND");
      record("invalid_project", "PASS", "Random valid-format nonexistent page ID returned sanitized NOT_FOUND.");
    });
  }
} catch (error) {
  record(active, failureStatus(error),
    error instanceof ConfigurationError ? { invalidFields: error.invalidFields }
      : error instanceof DomainError ? error.code : "Protocol or response assertion failed; raw details suppressed.");
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  if (child && exited) {
    const timer = setTimeout(() => child.kill(), 2_000);
    try {
      child.stdin.end();
      const [code] = await exited;
      const clean = code === 0 && invalidFrames === 0 && buffer === "" && logBuffer === "" && logLines > 0;
      record("stdio_hygiene", clean ? "PASS" : "FAIL", { cleanExit: code === 0, protocolAndLogFramingValid: invalidFrames === 0 && !buffer && !logBuffer });
    } catch { record("stdio_hygiene", "BLOCKED", "Server process could not be started or closed cleanly."); }
    finally { clearTimeout(timer); }
  }
}
const results = [...checks.values()];
const summary = Object.fromEntries(["PASS", "FAIL", "SKIP", "BLOCKED"].map((status) => [status, results.filter((result) => result.status === status).length]));
const status = summary.FAIL ? "FAIL" : summary.BLOCKED ? "BLOCKED" : summary.SKIP ? "PASS_WITH_LIMITATIONS" : "PASS";
process.stdout.write(JSON.stringify({ status, readOnly: true, summary, results }) + "\n");
process.exitCode = status === "FAIL" ? 1 : status === "BLOCKED" ? 2 : 0;
