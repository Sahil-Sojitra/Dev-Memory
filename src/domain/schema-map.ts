import type { DatabaseKey, ExpectedProperty } from "./notion-schema.ts";

// Captured by the successful read-only KAN-3 verification in this conversation.
// Names and option strings are case-sensitive; system property types are intentional.
const definition = {
  projects: {
    name: { name: "Name", type: "title" },
    description: { name: "Description", type: "rich_text" },
    repositoryUrl: { name: "Repository URL", type: "url" },
    status: { name: "Status", type: "select", options: ["Active", "Paused", "Archived"] },
    primaryStack: { name: "Primary Stack", type: "multi_select", options: ["JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Python", "Django", "FastAPI", "MongoDB", "PostgreSQL", "React Native"] },
    created: { name: "Created", type: "created_time" },
    lastUpdated: { name: "Last Updated", type: "last_edited_time" },
  },
  subprojects: {
    name: { name: "Name", type: "title" },
    description: { name: "Description", type: "rich_text" },
    type: { name: "Type", type: "select", options: ["Frontend", "Backend", "Mobile", "API / Service", "Infrastructure", "Feature", "Other"] },
    status: { name: "Status", type: "select", options: ["Active", "Paused", "Archived"] },
    repositoryPath: { name: "Repository Path", type: "rich_text" },
    project: { name: "Project", type: "relation", relation: "projects" },
  },
  knowledge: {
    name: { name: "Name", type: "title" },
    type: { name: "Type", type: "select", options: ["Implementation", "Technical Decision", "Error & Fix", "Setup / Runbook", "Reference", "Learning"] },
    verification: { name: "Verification", type: "select", options: ["Draft", "Hypothesis", "Verified", "Needs Review"] },
    context: { name: "Context / Environment", type: "rich_text" },
    files: { name: "Files / Paths", type: "rich_text" },
    sourceUrl: { name: "Source URL", type: "url" },
    tags: { name: "Tags", type: "multi_select", options: ["architecture", "frontend", "backend", "database", "deployment", "debugging", "auth", "performance", "testing"] },
    created: { name: "Created", type: "created_time" },
    lastUpdated: { name: "Last Updated", type: "last_edited_time" },
    project: { name: "Project", type: "relation", relation: "projects" },
    subproject: { name: "Subproject", type: "relation", relation: "subprojects" },
  },
} as const satisfies Record<DatabaseKey, Readonly<Record<string, ExpectedProperty>>>;

for (const properties of Object.values(definition)) {
  for (const property of Object.values(properties)) {
    if ("options" in property) Object.freeze(property.options);
    Object.freeze(property);
  }
  Object.freeze(properties);
}
export const NOTION_SCHEMA = Object.freeze(definition);

export type ProjectStatus = typeof NOTION_SCHEMA.projects.status.options[number];
export type PrimaryStack = typeof NOTION_SCHEMA.projects.primaryStack.options[number];
export type SubprojectType = typeof NOTION_SCHEMA.subprojects.type.options[number];
export type KnowledgeType = typeof NOTION_SCHEMA.knowledge.type.options[number];
export type KnowledgeVerification = typeof NOTION_SCHEMA.knowledge.verification.options[number];
export type KnowledgeTag = typeof NOTION_SCHEMA.knowledge.tags.options[number];
