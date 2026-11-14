import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { mapError } from "../domain/errors.ts";
import type { ProjectListingService } from "../domain/projects.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import type { AppLogger } from "../observability/logger.ts";
import { listProjectsInputSchema } from "../services/projects.ts";
import type { ProjectContextService } from "../domain/project-context.ts";
import { registerProjectContext } from "./project-context.ts";
import type { KnowledgeEntryService } from "../domain/knowledge-entry.ts";
import { registerKnowledgeEntry } from "./knowledge-entry.ts";

const outputSchema = z.strictObject({
  projects: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), url: z.url(),
    description: z.string().optional(), repositoryUrl: z.url().optional(),
    status: z.enum(NOTION_SCHEMA.projects.status.options).optional(),
    primaryStack: z.array(z.enum(NOTION_SCHEMA.projects.primaryStack.options)),
  })).max(100),
  hasMore: z.boolean(), nextCursor: z.string().nullable(),
});

// Preserve the precise advertised Zod JSON schema while withholding raw validation
// issues (which can contain unknown caller-supplied keys) from SDK error messages.
const safeInputSchema = {
  "~standard": {
    ...listProjectsInputSchema["~standard"],
    validate(input: unknown) {
      const parsed = listProjectsInputSchema.safeParse(input);
      if (parsed.success) return { value: parsed.data };
      return { issues: [{ message: "Invalid list_projects input. Use nameContains (1-200 characters), status (Active, Paused, Archived), limit (integer 1-100), and cursor (1-2048 characters)." }] };
    },
  },
};

export interface McpServices {
  readonly projects: ProjectListingService;
  readonly projectContext: ProjectContextService;
  readonly knowledgeEntry: KnowledgeEntryService;
  readonly logger: AppLogger;
}

// No transport or configuration ownership here. Each instance registers once;
// future HTTP callers can create fresh instances over the same business services.
export function createMcpServer(services: McpServices): McpServer {
  const server = new McpServer({ name: "devmemory", version: "0.1.0" }, {
    capabilities: { tools: { listChanged: false } }, maxToolInputElements: 16,
  });
  server.registerTool("list_projects", {
    description: "List Notion projects with case-insensitive nameContains and exact status filters. Scan one page (default 50, maximum 100 records). Name filtering can return fewer or zero matches while hasMore is true: follow nextCursor with the same filters and limit until hasMore is false.",
    inputSchema: safeInputSchema, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => withCorrelationId(async () => {
    try {
      // Enforce the application-owned contract before exposing a response.
      const result = outputSchema.parse(await services.projects.list(input));
      services.logger.info("list_projects_completed", { count: result.projects.length, hasMore: result.hasMore });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const safe = mapError(error, getCorrelationId() ?? "unavailable");
      services.logger.warn("list_projects_failed", { error: safe });
      const result = { error: safe };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  }));
  registerProjectContext(server, services.projectContext, services.logger);
  registerKnowledgeEntry(server, services.knowledgeEntry, services.logger);
  return server;
}
