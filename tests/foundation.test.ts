import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFoundation } from "../src/app.ts";
import { FAKE_NOTION_TOKEN, validEnvironment } from "./fixtures/environment.ts";

describe("foundation bootstrap", () => {
  it("validates and logs readiness without starting a listener", () => {
    const lines: string[] = [];
    expect(runFoundation(validEnvironment, { write(line: string) { lines.push(line); } })).toBe(0);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ msg: "foundation_ready", transport: "stdio" });
    expect(lines.join("")).not.toContain(FAKE_NOTION_TOKEN);
  });

  it("maps invalid configuration to a safe diagnostic and nonzero exit", () => {
    const lines: string[] = [];
    expect(runFoundation({ ...validEnvironment, LOG_LEVEL: "sensitive-invalid-log-level" }, { write(line: string) { lines.push(line); } })).toBe(1);
    const record = JSON.parse(lines[0] ?? "{}");
    expect(record.error.code).toBe("CONFIGURATION_ERROR");
    expect(record.invalidFields).toEqual(["LOG_LEVEL"]);
    expect(lines.join("")).not.toContain("sensitive-invalid-log-level");
    expect(lines.join("")).not.toContain(FAKE_NOTION_TOKEN);
  });

  it("runs the native TypeScript entry with empty stdout and exits cleanly", () => {
    // Explicit synthetic environment; never load the repository .env.
    const result = spawnSync(process.execPath, ["--import", "./tests/fixtures/notion-preload.mjs", "src/index.ts"], {
      cwd: process.cwd(),
      env: { SystemRoot: process.env.SystemRoot, ...validEnvironment },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("notion_schema_validated");
    expect(result.stderr).toContain("stdio_ready");
    expect(result.stderr).not.toContain(FAKE_NOTION_TOKEN);
  });
});
