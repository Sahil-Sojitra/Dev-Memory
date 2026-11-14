import type { CaptureWriter, CaptureInput, CaptureBlock } from "../../src/domain/capture-knowledge.ts";
import { createKnowledgeFixtureApi } from "./knowledge-entry.ts";
import { sourceIds } from "./notion.ts";
import { project } from "./projects.ts";

export const captureInput = Object.freeze({ projectId: project.id, title: "Captured note", type: "Implementation" as const });
export const capturedPage = Object.freeze({ id: "70000000-0000-4000-8000-000000000001", url: "https://www.notion.so/70000000000040008000000000000001" });
export function memoryCaptureWriter() {
  const creates: CaptureInput[] = [];
  const appends: (readonly CaptureBlock[])[] = [];
  const writer: CaptureWriter = {
    async prepare(budget) { budget.consume(); return { properties: {}, options: {} }; },
    async create(input, _bindings, budget) { budget.consume(); creates.push(input); return capturedPage; },
    async append(_page, blocks, budget) { budget.consume(); appends.push(blocks); },
  };
  return { writer, creates, appends };
}
export function createCaptureFixtureApi() {
  const api = createKnowledgeFixtureApi();
  const requests: Request[] = [];
  const creates: Record<string, unknown>[] = [];
  const appends: Record<string, unknown>[] = [];
  let count = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/pages") {
      creates.push(await request.json() as Record<string, unknown>);
      return Response.json({ object: "page", ...capturedPage, parent: { type: "data_source_id", data_source_id: sourceIds.knowledge } });
    }
    if (request.method === "PATCH" && url.pathname === "/v1/blocks/" + capturedPage.id + "/children") {
      const body = await request.json() as { children: object[] }; appends.push(body);
      return Response.json({ object: "list", results: body.children.map(() => ({ object: "block", id: "80000000-0000-4000-8000-" + String(++count).padStart(12, "0") })) });
    }
    if (!["GET", "POST"].includes(request.method)) throw new Error("Synthetic API forbids other mutations");
    const response = await api.fetch(input, init);
    if (request.method === "GET" && url.pathname === "/v1/data_sources/" + sourceIds.knowledge) {
      const data = await response.json() as { properties: Record<string, { id: string; type: string; select?: { options: { name: string; id?: string }[] }; multi_select?: { options: { name: string; id?: string }[] } }> };
      for (const field of Object.values(data.properties)) {
        const options = field.select?.options ?? field.multi_select?.options;
        options?.forEach((option, index) => { option.id = field.id + "_option_" + index; });
      }
      return Response.json(data);
    }
    return response;
  };
  return { ...api, fetch, requests, creates, appends };
}
