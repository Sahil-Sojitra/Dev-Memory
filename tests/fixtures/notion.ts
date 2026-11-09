import { validEnvironment } from "./environment.ts";

export const databaseIds: Record<"projects" | "subprojects" | "knowledge", string> = {
  projects: validEnvironment.NOTION_PROJECTS_DATABASE_ID,
  subprojects: validEnvironment.NOTION_SUBPROJECTS_DATABASE_ID,
  knowledge: validEnvironment.NOTION_KNOWLEDGE_DATABASE_ID,
};
export const sourceIds = {
  projects: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  subprojects: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  knowledge: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
type Key = keyof typeof databaseIds;
interface WireProperty {
  id: string;
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  relation?: { database_id?: string; data_source_id?: string };
}
function property(id: string, type: string): WireProperty { return { id, type }; }
function options(id: string, type: "select" | "multi_select", names: string[]): WireProperty {
  return { id, type, [type]: { options: names.map((name) => ({ name })) } };
}
function relation(id: string, target: Key): WireProperty {
  return { id, type: "relation", relation: { database_id: databaseIds[target], data_source_id: sourceIds[target] } };
}

// Independent KAN-3 fixture, not generated from the application's expected map.
export function notionFixtures() {
  const properties: Record<Key, Record<string, WireProperty>> = {
    projects: {
      Name: property("title", "title"),
      Description: property("p_desc", "rich_text"),
      "Repository URL": property("p_repo", "url"),
      Status: options("p_status", "select", ["Active", "Paused", "Archived"]),
      "Primary Stack": options("p_stack", "multi_select", ["JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Python", "Django", "FastAPI", "MongoDB", "PostgreSQL", "React Native"]),
      Created: property("p_created", "created_time"),
      "Last Updated": property("p_updated", "last_edited_time"),
    },
    subprojects: {
      Name: property("title", "title"),
      Description: property("s_desc", "rich_text"),
      Type: options("s_type", "select", ["Frontend", "Backend", "Mobile", "API / Service", "Infrastructure", "Feature", "Other"]),
      Status: options("s_status", "select", ["Active", "Paused", "Archived"]),
      "Repository Path": property("s_repo", "rich_text"),
      Project: relation("s_project", "projects"),
    },
    knowledge: {
      Name: property("title", "title"),
      Type: options("k_type", "select", ["Implementation", "Technical Decision", "Error & Fix", "Setup / Runbook", "Reference", "Learning"]),
      Verification: options("k_verify", "select", ["Draft", "Hypothesis", "Verified", "Needs Review"]),
      "Context / Environment": property("k_context", "rich_text"),
      "Files / Paths": property("k_files", "rich_text"),
      "Source URL": property("k_url", "url"),
      Tags: options("k_tags", "multi_select", ["architecture", "frontend", "backend", "database", "deployment", "debugging", "auth", "performance", "testing"]),
      Created: property("k_created", "created_time"),
      "Last Updated": property("k_updated", "last_edited_time"),
      Project: relation("k_project", "projects"),
      Subproject: relation("k_subproject", "subprojects"),
    },
  };
  const schemas = {
    projects: { object: "data_source", id: sourceIds.projects, parent: { type: "database_id", database_id: databaseIds.projects }, properties: properties.projects },
    subprojects: { object: "data_source", id: sourceIds.subprojects, parent: { type: "database_id", database_id: databaseIds.subprojects }, properties: properties.subprojects },
    knowledge: { object: "data_source", id: sourceIds.knowledge, parent: { type: "database_id", database_id: databaseIds.knowledge }, properties: properties.knowledge },
  };
  const databases = {
    projects: { object: "database", id: databaseIds.projects, data_sources: [{ id: sourceIds.projects, name: "Projects" }] },
    subprojects: { object: "database", id: databaseIds.subprojects, data_sources: [{ id: sourceIds.subprojects, name: "Subprojects" }] },
    knowledge: { object: "database", id: databaseIds.knowledge, data_sources: [{ id: sourceIds.knowledge, name: "Knowledge" }] },
  };
  return { databases, schemas };
}

export function createFixtureApi(fixtures = notionFixtures()) {
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    if (request.method !== "GET") throw new Error("Write attempted in read-only test");
    for (const key of ["projects", "subprojects", "knowledge"] as const) {
      if (request.url === "https://api.notion.com/v1/databases/" + databaseIds[key]) return Response.json(fixtures.databases[key]);
      if (request.url === "https://api.notion.com/v1/data_sources/" + sourceIds[key]) return Response.json(fixtures.schemas[key]);
    }
    throw new Error("Unexpected metadata URL");
  };
  return { fetch, requests, fixtures };
}
