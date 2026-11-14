import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { stdioConnection } from "./fixtures/mcp.ts";
import { FAKE_NOTION_TOKEN } from "./fixtures/environment.ts";
import { project } from "./fixtures/projects.ts";
import { detail } from "./fixtures/knowledge-entry.ts";
import { captureInput, capturedPage } from "./fixtures/capture-knowledge.ts";

describe("stdio entry with synthetic Notion API", () => {
  beforeAll(() => {
    // Exercise freshly compiled output even when npm test runs before npm build.
    const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.build.json"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 25_000);
  it.each(["src/index.ts", "dist/index.js"])("initializes, lists, calls and paginates via %s with clean protocol output", async (entry) => {
    const connection = stdioConnection(entry);
    try {
      expect((await connection.initialize()).result?.serverInfo?.name).toBe("devmemory");
      expect((await connection.request("tools/list")).result?.tools?.map((tool) => tool.name)).toEqual(["list_projects", "get_project_context", "get_knowledge_entry", "capture_knowledge"]);
      const first = await connection.request("tools/call", { name: "list_projects", arguments: { limit: 1 } });
      expect(first.result?.structuredContent).toEqual({ projects: [project], hasMore: true, nextCursor: "fixture:1" });
      const second = await connection.request("tools/call", { name: "list_projects", arguments: { limit: 1, cursor: "fixture:1" } });
      expect(second.result?.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
      expect(second.result?.structuredContent?.projects[0]?.name).toBe("Other Project");
      const filtered = await connection.request("tools/call", { name: "list_projects", arguments: { nameContains: "deVM", status: "Active", limit: 1 } });
      expect(filtered.result?.structuredContent).toEqual({ projects: [project], hasMore: false, nextCursor: null });
      const context = await connection.request("tools/call", { name: "get_project_context", arguments: { projectId: project.id, recentLimit: 1 } });
      expect(context.result?.isError).not.toBe(true);
      expect(context.result?.structuredContent).toMatchObject({ project, knowledgeCounts: { total: 1 }, requestBudget: { usedRequests: 6 } });
      const knowledge = await connection.request("tools/call", { name: "get_knowledge_entry", arguments: { pageId: detail.id } });
      expect(knowledge.result?.isError).not.toBe(true);
      expect(knowledge.result?.structuredContent).toMatchObject({ entry: detail, content: { markdown: "Readable content", truncated: false } });
      const captured = await connection.request("tools/call", { name: "capture_knowledge", arguments: { ...captureInput, content: "Synthetic body" } });
      expect(captured.result?.isError).not.toBe(true);
      expect(captured.result?.structuredContent).toMatchObject({ entry: { ...capturedPage, verification: "Draft" }, body: { complete: true, blocksWritten: 1 } });
    } finally { await connection.close(); }
    const diagnostics = connection.diagnostics();
    expect(diagnostics.invalidLines).toEqual([]);
    expect(diagnostics.buffer).toBe("");
    const logs = diagnostics.stderr.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(logs.map((log) => log.msg)).toContain("stdio_ready");
    expect(logs.map((log) => log.msg)).toContain("list_projects_completed");
    expect(logs.map((log) => log.msg)).toContain("stdio_closed");
    expect(diagnostics.stderr).not.toContain(project.name);
    expect(diagnostics.stderr + diagnostics.stdout).not.toContain(FAKE_NOTION_TOKEN);
    expect(connection.child.exitCode).toBe(0);
  });
  it("supports modern discovery used by Antigravity with no subscription capability", async () => {
    const connection = stdioConnection();
    try {
      const reply = await connection.request("server/discover", { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "devmemory-modern-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } });
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({ capabilities: { tools: { listChanged: false } } });
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "devmemory-modern-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      const listed = await connection.request("tools/list", { _meta: meta });
      expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["list_projects", "get_project_context", "get_knowledge_entry", "capture_knowledge"]);
      const called = await connection.request("tools/call", { _meta: meta, name: "list_projects", arguments: { limit: 1 } });
      expect(called.error).toBeUndefined();
      expect(called.result?.isError).not.toBe(true);
    } finally { await connection.close(); }
  });
  it.each(["SIGINT", "SIGTERM"])("closes gracefully when the %s listener runs", async (signal) => {
    const connection = stdioConnection("dist/index.js", { FIXTURE_SIGNAL: signal });
    try {
      await connection.initialize();
      await connection.exit;
      expect(connection.child.exitCode).toBe(0);
      expect(connection.diagnostics().stderr).toContain("stdio_closed");
      expect(connection.diagnostics().invalidLines).toEqual([]);
    } finally { await connection.close(); }
  });
  it("bounds signal shutdown even when an upstream request keeps a handle alive", async () => {
    const connection = stdioConnection("dist/index.js", { FIXTURE_SIGNAL: "SIGTERM", FIXTURE_HANG_QUERY: "1" });
    try {
      await connection.initialize();
      void connection.request("tools/call", { name: "list_projects" }).catch(() => {});
      await connection.exit;
      expect(connection.child.exitCode).toBe(1);
      expect(connection.diagnostics().stderr).toContain("stdio_closed");
      expect(connection.diagnostics().invalidLines).toEqual([]);
    } finally { await connection.close(); }
  });
  it("exits nonzero with no protocol output on missing configuration", () => {
    const result = spawnSync(process.execPath, ["dist/index.js"], { env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8", windowsHide: true, timeout: 5_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CONFIGURATION_ERROR");
    expect(result.stderr).not.toContain("stdio_ready");
  });
  it("exits nonzero without serving tools when the live schema gate fails", async () => {
    const connection = stdioConnection("dist/index.js", { FIXTURE_SCHEMA_FAILURE: "1" });
    try { await connection.exit; } finally { await connection.close(); }
    const diagnostics = connection.diagnostics();
    expect(connection.child.exitCode).toBe(1);
    expect(diagnostics.stdout).toBe("");
    expect(diagnostics.stderr).toContain("UNAUTHORIZED");
    expect(diagnostics.stderr).not.toContain("stdio_ready");
    expect(diagnostics.stderr).not.toContain("synthetic vendor payload");
  });
});
