import type { BodyBlock, KnowledgeDetail, KnowledgeEntryRepository } from "../../src/domain/knowledge-entry.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { knowledge, knowledgeRecord, subproject, createContextFixtureApi } from "./project-context.ts";
import { project } from "./projects.ts";

export const detail: KnowledgeDetail = Object.freeze({ ...knowledge, title: knowledge.name, created: "2026-10-01T00:00:00.000Z",
  projectIds: [project.id], subprojectIds: [subproject.id], relationsTruncated: false, relationTruncationReasons: [],
});
export function bodyBlock(index = 1, type = "paragraph", text = "Readable content"): BodyBlock {
  return { id: "40000000-0000-4000-8000-" + String(index).padStart(12, "0"), type, hasChildren: false, text, markdown: text, caption: "" };
}
export function memoryKnowledgeRepository(blocks: readonly BodyBlock[] = [bodyBlock()]): KnowledgeEntryRepository {
  return {
    async getEntry(id, budget) { budget.consume(); if (id !== detail.id) throw new DomainError("NOT_FOUND"); return detail; },
    async listBlocks(_id, cursor, budget) {
      budget.consume();
      const offset = Number(cursor ?? 0);
      const items = blocks.slice(offset, offset + 100);
      const hasMore = offset + items.length < blocks.length;
      return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : null };
    },
  };
}
export function wireBlock(index = 1, type = "paragraph", text = "Readable content", hasChildren = false) {
  return { object: "block", id: bodyBlock(index).id, type, has_children: hasChildren, [type]: { rich_text: [{ plain_text: text }] } };
}
export function createKnowledgeFixtureApi() {
  const context = createContextFixtureApi();
  const record = { ...knowledgeRecord(), properties: { ...knowledgeRecord().properties,
    Created: { id: "k_created", type: "created_time", created_time: detail.created },
  } };
  const blocks = new Map<string, unknown[]>([[detail.id, [wireBlock()]]]);
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/pages/" + detail.id) return Response.json(record);
    if (request.method === "GET" && url.pathname.includes("/blocks/") && url.pathname.endsWith("/children")) {
      const id = url.pathname.split("/")[3]!;
      const entries = blocks.get(id) ?? [];
      const offset = Number(url.searchParams.get("start_cursor") ?? 0);
      const results = entries.slice(offset, offset + 100);
      const hasMore = offset + results.length < entries.length;
      return Response.json({ object: "list", results, has_more: hasMore, next_cursor: hasMore ? String(offset + results.length) : null });
    }
    return context.fetch(input, init);
  };
  return { fetch, record, blocks, requests };
}
