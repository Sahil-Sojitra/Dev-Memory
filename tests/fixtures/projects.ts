import type { ListProjectsInput, Project, ProjectPage, ProjectRepository } from "../../src/domain/projects.ts";
import { sourceIds, createFixtureApi } from "./notion.ts";

export const project: Project = Object.freeze({
  id: "10000000-0000-4000-8000-000000000001", name: "DevMemory", url: "https://www.notion.so/10000000000040008000000000000001",
  description: "Developer memory", repositoryUrl: "https://github.com/example/devmemory", status: "Active",
  primaryStack: ["TypeScript", "Node.js"] as const,
});

export function projectRecord(value: Project = project) {
  const properties: Record<string, Record<string, unknown>> = {
    Name: { id: "title", type: "title", title: [{ plain_text: value.name }] },
    Description: { id: "p_desc", type: "rich_text", rich_text: value.description ? [{ plain_text: value.description }] : [] },
    "Repository URL": { id: "p_repo", type: "url", url: value.repositoryUrl ?? null },
    Status: { id: "p_status", type: "select", select: value.status ? { name: value.status } : null },
    "Primary Stack": { id: "p_stack", type: "multi_select", multi_select: value.primaryStack.map((name) => ({ name })) },
    Created: { id: "p_created", type: "created_time", created_time: "2026-01-01T00:00:00Z" },
    "Last Updated": { id: "p_updated", type: "last_edited_time", last_edited_time: "2026-01-01T00:00:00Z" },
  };
  return { object: "page", id: value.id, url: value.url, parent: { type: "data_source_id", data_source_id: sourceIds.projects }, properties,
    created_by: { secret: "synthetic-notion-data-not-for-output" } };
}

export function inMemoryProjects(values: readonly Project[] = [project]): ProjectRepository {
  return {
    async list(input: Omit<ListProjectsInput, "nameContains">): Promise<ProjectPage> {
      const filtered = values.filter((value) => !input.status || value.status === input.status);
      const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0;
      const projects = filtered.slice(offset, offset + input.limit);
      const hasMore = offset + projects.length < filtered.length;
      return { projects, hasMore, nextCursor: hasMore ? "fixture:" + (offset + projects.length) : null };
    },
  };
}

// Synthetic read-only API for child-process protocol tests. Never falls through
// to the network; implements the documented upstream filters before pagination.
export function createProjectFixtureApi() {
  const metadata = createFixtureApi();
  const values: readonly Project[] = [project, { ...project, id: "10000000-0000-4000-8000-000000000002", name: "Other Project", status: "Paused" }];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url === "https://api.notion.com/v1/data_sources/" + sourceIds.projects + "/query") {
      const body = await request.json() as {
        page_size: number; start_cursor?: string;
        filter?: { and?: { title?: { contains: string }; select?: { equals: "Active" | "Paused" | "Archived" } }[]; title?: { contains: string }; select?: { equals: "Active" | "Paused" | "Archived" } };
      };
      const filters = body.filter?.and ?? (body.filter ? [body.filter] : []);
      const status = filters.find((filter) => filter.select)?.select?.equals;
      const page = await inMemoryProjects(values).list({ limit: body.page_size,
        ...(body.start_cursor ? { cursor: body.start_cursor } : {}),
        ...(status ? { status } : {}),
      });
      return Response.json({ object: "list", results: page.projects.map(projectRecord), has_more: page.hasMore, next_cursor: page.nextCursor });
    }
    return metadata.fetch(input, init);
  };
  return { fetch };
}
