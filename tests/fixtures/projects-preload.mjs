import { createProjectFixtureApi } from "./projects.ts";
import { createKnowledgeFixtureApi } from "./knowledge-entry.ts";

// Test-only preload: all requests are synthetic, with no network fallback.
const api = createProjectFixtureApi();
const knowledgeApi = createKnowledgeFixtureApi();
globalThis.fetch = process.env.FIXTURE_SCHEMA_FAILURE === "1"
  ? async () => Response.json({ object: "error", status: 401, code: "unauthorized", message: "synthetic vendor payload" }, { status: 401 })
  : async (input, init) => {
    if (process.env.FIXTURE_HANG_QUERY === "1" && new Request(input, init).url.endsWith("/query")) {
      // Simulate an upstream socket holding the process alive after MCP close.
      return new Promise(() => { setInterval(() => {}, 1_000); });
    }
    const url = new Request(input, init).url;
    if ((url.includes("/pages/") || url.includes("/blocks/")) || url.includes("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/query") || url.includes("cccccccc-cccc-4ccc-8ccc-cccccccccccc/query")) return knowledgeApi.fetch(input, init);
    return api.fetch(input, init);
  };

// Exercise Node signal listeners portably (Windows kill() forcibly terminates).
if (["SIGINT", "SIGTERM"].includes(process.env.FIXTURE_SIGNAL)) {
  setTimeout(() => process.emit(process.env.FIXTURE_SIGNAL), 750).unref();
}
