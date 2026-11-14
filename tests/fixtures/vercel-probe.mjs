import assert from "node:assert/strict";
import { FAKE_BEARER_TOKEN } from "./environment.ts";
import entry from "../../dist/vercel/api/index.js";

// Run only with the synthetic API preload and an explicit test environment.
// This invokes the actual compiled Vercel entry, never a test-only route factory.
const counts = { queries: 0, metadata: 0, pages: 0 };
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "POST") counts.queries++;
  else if (new URL(request.url).pathname.includes("/pages/")) counts.pages++;
  else counts.metadata++;
  return fixtureFetch(input, init);
};
const url = "https://memory.example.test";
const headers = { authorization: "Bearer " + FAKE_BEARER_TOKEN, "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = async (body) => {
  const response = await entry.fetch(new Request(url + "/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const text = await response.text();
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5)) : JSON.parse(text);
};
assert.equal((await entry.fetch(new Request(url + "/api/health"))).status, 200);
assert.equal((await entry.fetch(new Request(url + "/api/mcp", { method: "POST", headers: { ...headers, authorization: "Bearer synthetic-wrong-token-32-characters" }, body: "{" }))).status, 401);
assert.deepEqual(counts, { metadata: 0, queries: 0, pages: 0 });
assert.equal((await entry.fetch(new Request(url + "/api/ready", { headers }))).status, 200);
const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "kan10-vercel-contract", version: "1.0.0" } } });
assert.equal(initialized.result.serverInfo.name, "devmemory");
const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["list_projects", "get_project_context", "get_knowledge_entry"]);
const calls = await Promise.all([1, 2].map((id) => rpc({ jsonrpc: "2.0", id: id + 2, method: "tools/call", params: { name: "list_projects", arguments: { limit: 1 } } })));
for (const result of calls) {
  assert.equal(result.result.isError, undefined);
  assert.equal(result.result.structuredContent.projects.length, 1);
}
assert.deepEqual(counts, { metadata: 6, queries: 2, pages: 0 });
const contexts = await Promise.all([10, 11].map((id) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_project_context", arguments: { projectId: calls[0].result.structuredContent.projects[0].id, recentLimit: 1 } } })));
for (const result of contexts) {
  assert.equal(result.result.isError, undefined);
  assert.equal(result.result.structuredContent.knowledgeCounts.total, 1);
  assert.equal(result.result.structuredContent.requestBudget.usedRequests, 6);
}
assert.deepEqual(counts, { metadata: 6, queries: 12, pages: 2 });
process.stdout.write(JSON.stringify({ status: "PASS", scope: "local compiled Vercel fetch contract, synthetic API", checks: ["health", "invalid_auth_before_initialization", "ready", "initialize", "tools_list", "parallel_tools_call", "project_context", "no_session"], ...counts }) + "\n");
