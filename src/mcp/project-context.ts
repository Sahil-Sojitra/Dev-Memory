import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ProjectContextService } from "../domain/project-context.ts";
import type { AppLogger } from "../observability/logger.ts";
import { mapError } from "../domain/errors.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import { contextInputSchema } from "../services/project-context.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";

export const projectOutputSchema = z.strictObject({
  id: z.uuid(), name: z.string(), url: z.url(), description: z.string().optional(), repositoryUrl: z.url().optional(),
  status: z.enum(NOTION_SCHEMA.projects.status.options).optional(), primaryStack: z.array(z.enum(NOTION_SCHEMA.projects.primaryStack.options)),
});
const subproject = z.strictObject({
  id: z.uuid(), name: z.string(), url: z.url(), description: z.string().optional(), repositoryPath: z.string().optional(),
  type: z.enum(NOTION_SCHEMA.subprojects.type.options).optional(), status: z.enum(NOTION_SCHEMA.subprojects.status.options).optional(), projectIds: z.array(z.uuid()),
});
const entry = z.strictObject({
  id: z.uuid(), name: z.string(), url: z.url(), lastUpdated: z.iso.datetime({ offset: true }),
  type: z.enum(NOTION_SCHEMA.knowledge.type.options).optional(), verification: z.enum(NOTION_SCHEMA.knowledge.verification.options).optional(),
  context: z.string().optional(), files: z.string().optional(), sourceUrl: z.url().optional(), tags: z.array(z.enum(NOTION_SCHEMA.knowledge.tags.options)),
});
const scan = z.strictObject({ scanned: z.number().int().min(0).max(500), complete: z.boolean(), truncated: z.boolean(), reason: z.enum(["scan_limit", "request_budget", "result_limit"]).nullable() });
const output = z.strictObject({
  project: projectOutputSchema, subprojectId: z.uuid().optional(), subprojects: z.array(subproject).max(500),
  knowledgeCounts: z.strictObject({ total: z.number().int().min(0).max(500),
    byType: z.record(z.enum([...NOTION_SCHEMA.knowledge.type.options, "Unspecified"]), z.number().int().min(0)),
    byVerification: z.record(z.enum([...NOTION_SCHEMA.knowledge.verification.options, "Unspecified"]), z.number().int().min(0)),
  }),
  recentKnowledge: z.array(entry).max(25), setupRunbooks: z.array(entry).max(25), needsReview: z.array(entry).max(25),
  scan: z.strictObject({ subprojects: scan, knowledgeCounts: scan, recentKnowledge: scan, setupRunbooks: scan, needsReview: scan }),
  requestBudget: z.strictObject({ maxRequests: z.number().int().positive(), usedRequests: z.number().int().min(0), maxDurationMs: z.number().positive() }),
});
const input = { "~standard": { ...contextInputSchema["~standard"], validate(value: unknown) {
  const parsed = contextInputSchema.safeParse(value);
  return parsed.success ? { value: parsed.data } : { issues: [{ message: "Invalid get_project_context input. Supply projectId (UUID), optional subprojectId (UUID), and recentLimit (integer 1-25)." }] };
} } };

export function registerProjectContext(server: McpServer, service: ProjectContextService, logger: AppLogger): void {
  server.registerTool("get_project_context", {
    description: "Read project details, associated subprojects, scoped knowledge counts and independent recent/setup/needs-review lists. Each list defaults to 10 entries (maximum 25), newest updated first. Inspect scan completeness flags: counts are lower bounds when truncated. Optional subprojectId scopes knowledge only and must belong to the project.",
    inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (value) => withCorrelationId(async () => {
    try {
      const result = output.parse(await service.get(value));
      logger.info("get_project_context_completed", { subprojects: result.subprojects.length, knowledgeScanned: result.knowledgeCounts.total, requests: result.requestBudget.usedRequests });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const safe = mapError(error, getCorrelationId() ?? "unavailable");
      logger.warn("get_project_context_failed", { error: safe });
      const result = { error: safe };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  }));
}
