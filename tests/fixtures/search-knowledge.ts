import type { SearchCandidate, SearchInput, SearchRepository } from "../../src/domain/search-knowledge.ts";
import type { KnowledgeEntryRepository } from "../../src/domain/knowledge-entry.ts";
import { createSearchService } from "../../src/services/search-knowledge.ts";
import { createKnowledgeEntryService } from "../../src/services/knowledge-entry.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { knowledge, subproject, memoryContextRepository, knowledgeRecord } from "./project-context.ts";
import { project } from "./projects.ts";
import { bodyBlock, wireBlock, detail } from "./knowledge-entry.ts";
import { createCaptureFixtureApi } from "./capture-knowledge.ts";
import { sourceIds } from "./notion.ts";

export const otherProject = "10000000-0000-4000-8000-000000000002";
export const otherSubproject = "20000000-0000-4000-8000-000000000002";
export function candidate(index = 1, overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return { ...knowledge, id: "30000000-0000-4000-8000-" + String(index).padStart(12, "0"), name: "Ordinary note", context: "", files: "", sourceUrl: "https://example.test", tags: [],
    projectIds: [project.id], subprojectIds: [subproject.id], relationsTruncated: false, ...overrides };
}
export const golden = [
  candidate(1, { name: "Deploy node" }),
  candidate(2, { name: "How to deploy node safely" }),
  candidate(3, { context: "deploy node" }),
  candidate(4, { files: "src/deploy/node.ts" }),
  candidate(5, { tags: ["deployment"] }),
  candidate(6), // Body-only: deploy node.
  candidate(7, { name: "Deploy worker", context: "deploy node", files: "deploy/node.ts" }),
  candidate(8, { name: "deployment nodes" }), // Similar words are not token matches.
  candidate(9, { context: "deploy node", projectIds: [otherProject], subprojectIds: [otherSubproject], type: "Error & Fix", verification: "Verified" }),
  candidate(10, { sourceUrl: "https://example.test/deploy/node" }),
] satisfies SearchCandidate[];
export function matches(row: SearchCandidate, input: SearchInput): boolean {
  return (!input.projectId || row.projectIds.includes(input.projectId)) && (!input.subprojectId || row.subprojectIds.includes(input.subprojectId))
    && (!input.type || input.type.includes(row.type!)) && (!input.verification || input.verification.includes(row.verification!))
    && (!input.tags || input.tags.every((tag) => row.tags.includes(tag)));
}
export function memorySearch(rows: readonly SearchCandidate[] = golden, bodyText: ReadonlyMap<string, string> = new Map([[golden[5]!.id, "deploy node"]])) {
  const calls = { candidates: 0, entries: 0, blocks: 0 };
  const repository: SearchRepository = { async list(input, limit, cursor, budget) {
    calls.candidates++; budget.consume(); const selected = rows.filter((row) => matches(row, input)); const offset = Number(cursor ?? 0);
    const items = selected.slice(offset, offset + limit); const hasMore = offset + items.length < selected.length;
    return { items, hasMore, nextCursor: hasMore ? String(offset + items.length) : null };
  } };
  const bodyRepository: KnowledgeEntryRepository = {
    async getEntry(id, budget) { calls.entries++; budget.consume(); const row = rows.find((item) => item.id === id); if (!row) throw new DomainError("NOT_FOUND");
      return { ...row, title: row.name, created: detail.created, relationTruncationReasons: [] }; },
    async listBlocks(id, _cursor, budget) { calls.blocks++; budget.consume(); return { items: [bodyBlock(1, "paragraph", bodyText.get(id) ?? "unrelated body")], hasMore: false, nextCursor: null }; },
  };
  const scope = memoryContextRepository(rows, [subproject, { ...subproject, id: otherSubproject, projectIds: [otherProject] }]);
  const bodies = createKnowledgeEntryService(bodyRepository);
  return { repository, bodyRepository, bodies, scope, calls, service: createSearchService(repository, scope, bodies) };
}

// Fake HTTP oracle: evaluates the Notion filter tree independently of the
// service matcher. No network fallback and no real credentials are used.
export function createSearchFixtureApi(rows: readonly SearchCandidate[] = [candidate(1, knowledge)], bodyText: ReadonlyMap<string, string> = new Map()) {
  const base = createCaptureFixtureApi(); const requests: Request[] = [];
  function record(row: SearchCandidate) {
    const raw = knowledgeRecord(row);
    return { ...raw, properties: { ...raw.properties, Created: { id: "k_created", type: "created_time", created_time: detail.created },
      Project: { id: "k_project", type: "relation", relation: row.projectIds.map((id) => ({ id })), has_more: row.relationsTruncated },
      Subproject: { id: "k_subproject", type: "relation", relation: row.subprojectIds.map((id) => ({ id })), has_more: false } } };
  }
  interface Filter { and?: Filter[]; or?: Filter[]; property?: string; select?: { equals: string }; relation?: { contains: string }; multi_select?: { contains: string } }
  function accepts(row: SearchCandidate, filter?: Filter): boolean {
    if (!filter) return true;
    if (filter.and) return filter.and.every((item) => accepts(row, item));
    if (filter.or) return filter.or.some((item) => accepts(row, item));
    if (filter.select) return (filter.property === "k_type" ? row.type : row.verification) === filter.select.equals;
    if (filter.multi_select) return row.tags.some((tag) => tag === filter.multi_select!.contains);
    if (filter.relation) return (filter.property === "k_project" ? row.projectIds : row.subprojectIds).includes(filter.relation.contains);
    return false;
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/data_sources/" + sourceIds.knowledge + "/query") {
      const body = await request.json() as { page_size: number; start_cursor?: string; filter?: Filter };
      const selected = rows.filter((row) => accepts(row, body.filter)).sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));
      const offset = Number(body.start_cursor ?? 0), items = selected.slice(offset, offset + body.page_size), hasMore = offset + items.length < selected.length;
      return Response.json({ object: "list", results: items.map(record), has_more: hasMore, next_cursor: hasMore ? String(offset + items.length) : null });
    }
    const row = rows.find((item) => url.pathname === "/v1/pages/" + item.id);
    if (request.method === "GET" && row) return Response.json(record(row));
    const bodyRow = rows.find((item) => url.pathname === "/v1/blocks/" + item.id + "/children");
    if (request.method === "GET" && bodyRow) return Response.json({ object: "list", results: [wireBlock(1, "paragraph", bodyText.get(bodyRow.id) ?? "Readable content")], has_more: false, next_cursor: null });
    return base.fetch(input, init);
  };
  return { fetch, requests, base };
}
