import type { KnowledgeEntry, Subproject, ProjectContextRepository, ContextPage } from "../../src/domain/project-context.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { project, projectRecord } from "./projects.ts";
import { createFixtureApi, sourceIds } from "./notion.ts";

export const subproject: Subproject = Object.freeze({ id: "20000000-0000-4000-8000-000000000001", name: "Backend", url: "https://notion.so/subproject", projectIds: [project.id], type: "Backend", status: "Active", description: "Service", repositoryPath: "src" });
export const knowledge: KnowledgeEntry = Object.freeze({ id: "30000000-0000-4000-8000-000000000001", name: "Setup", url: "https://notion.so/knowledge", lastUpdated: "2026-11-01T00:00:00.000Z", type: "Setup / Runbook", verification: "Needs Review", context: "Synthetic setup instructions", files: "src/index.ts", sourceUrl: "https://example.test/setup", tags: ["deployment"] as const });
export function memoryContextRepository(entries: readonly KnowledgeEntry[] = [knowledge], children: readonly Subproject[] = [subproject]): ProjectContextRepository {
  function slice<T>(items: readonly T[], limit: number, cursor?: string): ContextPage<T> {
    const offset = cursor ? Number(cursor) : 0;
    const result = items.slice(offset, offset + limit);
    const hasMore = offset + result.length < items.length;
    return { items: result, hasMore, nextCursor: hasMore ? String(offset + result.length) : null };
  }
  return {
    async getProject(id, budget) { budget.consume(); if (id !== project.id) throw new DomainError("NOT_FOUND"); return project; },
    async getSubproject(id, budget) { budget.consume(); const found = children.find((child) => child.id === id); if (!found) throw new DomainError("NOT_FOUND"); return found; },
    async listSubprojects(projectId, limit, cursor, budget) { budget.consume(); return slice(children.filter((item) => item.projectIds.includes(projectId)), limit, cursor); },
    async listKnowledge(input, budget) {
      budget.consume();
      const filtered = entries.filter((item) => input.category === "setup" ? item.type === "Setup / Runbook" : input.category === "needsReview" ? item.verification === "Needs Review" : true);
      return slice([...filtered].sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated)), input.limit, input.cursor);
    },
    async scanKnowledge(input, budget) { budget.consume(); return slice(entries, input.limit, input.cursor); },
  };
}

export function subprojectRecord(value: Subproject = subproject) {
  return { object: "page", id: value.id, url: value.url, parent: { type: "data_source_id", data_source_id: sourceIds.subprojects },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: value.name }] },
      Description: { id: "s_desc", type: "rich_text", rich_text: [{ plain_text: value.description ?? "" }] },
      Type: { id: "s_type", type: "select", select: value.type ? { name: value.type } : null },
      Status: { id: "s_status", type: "select", select: value.status ? { name: value.status } : null },
      "Repository Path": { id: "s_repo", type: "rich_text", rich_text: [{ plain_text: value.repositoryPath ?? "" }] },
      Project: { id: "s_project", type: "relation", relation: value.projectIds.map((id) => ({ id })), has_more: false },
    },
  };
}
export function knowledgeRecord(value: KnowledgeEntry = knowledge, subprojectId = subproject.id) {
  return { object: "page", id: value.id, url: value.url, parent: { type: "data_source_id", data_source_id: sourceIds.knowledge },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: value.name }] },
      Type: { id: "k_type", type: "select", select: value.type ? { name: value.type } : null },
      Verification: { id: "k_verify", type: "select", select: value.verification ? { name: value.verification } : null },
      "Context / Environment": { id: "k_context", type: "rich_text", rich_text: [{ plain_text: value.context ?? "" }] },
      "Files / Paths": { id: "k_files", type: "rich_text", rich_text: [{ plain_text: value.files ?? "" }] },
      "Source URL": { id: "k_url", type: "url", url: value.sourceUrl ?? null },
      Tags: { id: "k_tags", type: "multi_select", multi_select: value.tags.map((name) => ({ name })) },
      "Last Updated": { id: "k_updated", type: "last_edited_time", last_edited_time: value.lastUpdated },
      Project: { id: "k_project", type: "relation", relation: [{ id: project.id }] },
      Subproject: { id: "k_subproject", type: "relation", relation: [{ id: subprojectId }] },
    },
  };
}

export function createContextFixtureApi() {
  const metadata = createFixtureApi();
  const requests: Request[] = [];
  const children = [subprojectRecord()];
  const entries = [knowledgeRecord()];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "GET" && request.url.endsWith("/pages/" + project.id)) return Response.json(projectRecord());
    if (request.method === "GET" && request.url.endsWith("/pages/" + subproject.id)) return Response.json(children[0]);
    if (request.method === "POST" && request.url.endsWith("/query")) {
      const body = await request.clone().json() as { page_size: number; start_cursor?: string; filter: { and?: { property: string; select?: { equals: string }; relation?: { contains: string } }[]; property?: string; relation?: { contains: string } } };
      const filters = body.filter.and ?? [body.filter];
      const records = request.url.includes(sourceIds.subprojects) ? children : entries;
      const selected = records.filter((record) => filters.every((filter) => {
        const properties = Object.values(record.properties) as { id: string; relation?: { id: string }[]; select?: { name: string } | null }[];
        const field = properties.find((property) => property.id === filter.property);
        return "select" in filter && filter.select ? field?.select?.name === filter.select.equals : field?.relation?.some((relation) => relation.id === filter.relation?.contains);
      }));
      if (request.url.includes(sourceIds.knowledge)) selected.sort((a, b) => {
        const updated = (record: typeof a) => (Object.values(record.properties).find((item) => item.id === "k_updated") as { last_edited_time: string }).last_edited_time;
        return Date.parse(updated(b)) - Date.parse(updated(a));
      });
      const offset = Number(body.start_cursor ?? 0);
      const items = selected.slice(offset, offset + body.page_size);
      const hasMore = offset + items.length < selected.length;
      return Response.json({ object: "list", results: items, has_more: hasMore, next_cursor: hasMore ? String(offset + items.length) : null });
    }
    if (request.url.includes("/pages/")) return Response.json({ object: "error", code: "object_not_found", message: "Synthetic missing page" }, { status: 404 });
    return metadata.fetch(input, init);
  };
  return { fetch, requests, metadata, children, entries };
}
