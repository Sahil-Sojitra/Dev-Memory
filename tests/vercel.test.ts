import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { FAKE_BEARER_TOKEN, FAKE_NOTION_TOKEN, validHttpEnvironment } from "./fixtures/environment.ts";

describe("Vercel entry contract (no hosted deployment)", () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.vercel.json"], { windowsHide: true, encoding: "utf8", timeout: 25_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
  }, 30_000);

  it("routes the three public paths to one Node function with no socket server", () => {
    const config = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { rewrites: { source: string; destination: string }[]; functions: Record<string, { maxDuration: number }> };
    expect(config.rewrites).toEqual([
      { source: "/api/mcp", destination: "/api" }, { source: "/api/health", destination: "/api" }, { source: "/api/ready", destination: "/api" },
    ]);
    expect(config.functions["api/index.ts"]?.maxDuration).toBe(60);
    expect(fs.existsSync("dist/vercel/api/index.js")).toBe(true);
  });

  it("runs real compiled bootstrap, Notion query adapter and MCP factory through fetch", () => {
    const result = spawnSync(process.execPath, ["--import", "./tests/fixtures/projects-preload.mjs", "tests/fixtures/vercel-probe.mjs"], {
      env: { SystemRoot: process.env.SystemRoot, ...validHttpEnvironment }, windowsHide: true, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "PASS", metadata: 6, queries: 2 });
    expect(result.stderr).toContain("notion_schema_validated");
    expect(result.stderr).toContain("list_projects_completed");
    expect(result.stdout + result.stderr).not.toContain(FAKE_BEARER_TOKEN);
    expect(result.stdout + result.stderr).not.toContain(FAKE_NOTION_TOKEN);
  });
});
