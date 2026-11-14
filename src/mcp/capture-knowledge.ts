import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { captureInputSchema, PartialWriteError, WriteConfirmedAfterDeadlineError } from "../domain/capture-knowledge.ts";
import type { CaptureService } from "../domain/capture-knowledge.ts";
import { mapError } from "../domain/errors.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import type { AppLogger } from "../observability/logger.ts";

const output = z.strictObject({
  entry: z.strictObject({ id: z.uuid(), url: z.url(), verification: z.enum(["Draft", "Hypothesis", "Needs Review"]) }),
  body: z.strictObject({ complete: z.literal(true), blocksWritten: z.number().int().min(0).max(500), batchesWritten: z.number().int().min(0).max(5) }),
  warnings: z.array(z.enum(["DUPLICATE_TITLE", "DUPLICATE_CHECK_INCOMPLETE"])),
  duplicateCheck: z.strictObject({ complete: z.boolean(), scanned: z.number().int().min(0).max(500), matches: z.number().int().min(0).max(500) }),
  requestBudget: z.strictObject({ maxRequests: z.number().int().positive(), usedRequests: z.number().int().min(0), maxDurationMs: z.number().positive() }),
});
const input = { "~standard": { ...captureInputSchema["~standard"], validate(value: unknown) {
  const parsed = captureInputSchema.safeParse(value);
  return parsed.success ? { value: parsed.data } : { issues: [{ message: "Invalid capture_knowledge input. Supply projectId, title and an approved Type. Verification must be Draft, Hypothesis or Needs Review; only a human may manually mark knowledge Verified in Notion after checking it." }] };
} } };
export function registerCapture(server: McpServer, service: CaptureService, logger: AppLogger): void {
  server.registerTool("capture_knowledge", {
    description: "Create a new Knowledge entry with validated project/subproject relations. Defaults to Draft; Verified is forbidden and requires human review in Notion. Writes never update existing entries. Do not automatically retry PARTIAL_WRITE or WRITE_OUTCOME_UNKNOWN: inspect the existing page first. Duplicate titles produce warnings.",
    inputSchema: input, outputSchema: output,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (value) => withCorrelationId(async () => {
    try {
      const result = output.parse(await service.capture(value));
      logger.info("capture_knowledge_completed", { blocks: result.body.blocksWritten, batches: result.body.batchesWritten, warnings: result.warnings.length });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const safe = mapError(error, getCorrelationId() ?? "unavailable");
      // Recovery identifiers are response data, never diagnostic log fields.
      logger.warn("capture_knowledge_failed", { error: safe });
      const result = { error: safe, ...(error instanceof PartialWriteError || error instanceof WriteConfirmedAfterDeadlineError ? { recovery: error.recovery } : {}) };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  }));
}
