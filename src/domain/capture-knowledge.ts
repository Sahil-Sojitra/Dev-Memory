import * as z from "zod";
import { NOTION_SCHEMA } from "./schema-map.ts";
import { DomainError, RequestValidationError } from "./errors.ts";
import type { RequestBudget } from "./project-context.ts";

export const CAPTURE_MAX_BYTES = 48_000;
export const CAPTURE_MAX_BLOCKS = 500;
export const captureInputSchema = z.strictObject({
  projectId: z.uuid().transform((value) => value.toLowerCase()),
  subprojectId: z.uuid().transform((value) => value.toLowerCase()).optional(),
  title: z.string().trim().min(1).max(200), type: z.enum(NOTION_SCHEMA.knowledge.type.options),
  content: z.string().min(1).max(20_000).refine((value) => value.trim().length > 0).optional(),
  context: z.string().trim().min(1).max(2000).optional(),
  filePaths: z.array(z.string().trim().min(1).max(200)).min(1).max(10).refine((values) => new Set(values).size === values.length).optional(),
  sourceUrl: z.string().max(2000).url().refine((value) => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  }).optional(),
  tags: z.array(z.enum(NOTION_SCHEMA.knowledge.tags.options)).max(NOTION_SCHEMA.knowledge.tags.options.length).refine((values) => new Set(values).size === values.length).optional(),
  verification: z.enum(["Draft", "Hypothesis", "Needs Review"]).default("Draft"),
}).refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= CAPTURE_MAX_BYTES)
  .refine((value) => Object.keys(value).length + (value.filePaths?.length ?? 0) + (value.tags?.length ?? 0) <= 16);
export type CaptureInput = z.infer<typeof captureInputSchema>;
export function validateCapture(input: unknown): CaptureInput {
  if (typeof input === "object" && input !== null && "verification" in input && input.verification === "Verified") throw new DomainError("VERIFICATION_REQUIRES_HUMAN");
  const result = captureInputSchema.safeParse(input);
  if (!result.success) {
    const allowed = Object.keys(captureInputSchema.shape);
    throw new RequestValidationError([...new Set(result.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? "input"); return allowed.includes(field) ? field : "input";
    }))].map((field) => ({ field })));
  }
  return result.data;
}
export interface CaptureBlock {
  readonly type: "paragraph" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item" | "numbered_list_item" | "to_do" | "quote" | "code" | "divider";
  readonly text: string;
  readonly checked?: boolean;
  readonly language?: string;
}
export interface CaptureBindings {
  readonly properties: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface CreatedKnowledge { readonly id: string; readonly url: string }
export interface CaptureWriter {
  prepare(budget: RequestBudget): Promise<CaptureBindings>;
  create(input: CaptureInput, bindings: CaptureBindings, budget: RequestBudget): Promise<CreatedKnowledge>;
  append(page: CreatedKnowledge, blocks: readonly CaptureBlock[], budget: RequestBudget): Promise<void>;
}
export interface CaptureRecovery {
  readonly pageId: string; readonly url: string; readonly confirmedBatches: number; readonly totalBatches: number;
  readonly confirmedBlocks: number; readonly totalBlocks: number; readonly bodyComplete: boolean;
  readonly failedBatchOutcome: "not_sent" | "rejected" | "unknown"; readonly doNotRetryCapture: true;
}
export class PartialWriteError extends DomainError {
  readonly recovery: CaptureRecovery;
  constructor(recovery: CaptureRecovery) { super("PARTIAL_WRITE"); this.recovery = Object.freeze(recovery); }
}
export class WriteConfirmedAfterDeadlineError extends DomainError {
  readonly recovery: Omit<CaptureRecovery, "failedBatchOutcome">;
  constructor(recovery: Omit<CaptureRecovery, "failedBatchOutcome">) {
    super("WRITE_CONFIRMED_AFTER_DEADLINE"); this.recovery = Object.freeze(recovery);
  }
}
export interface CaptureResult {
  readonly entry: CreatedKnowledge & { readonly verification: CaptureInput["verification"] };
  readonly body: { readonly complete: true; readonly blocksWritten: number; readonly batchesWritten: number };
  readonly warnings: readonly ("DUPLICATE_TITLE" | "DUPLICATE_CHECK_INCOMPLETE")[];
  readonly duplicateCheck: { readonly complete: boolean; readonly scanned: number; readonly matches: number };
  readonly requestBudget: { readonly maxRequests: number; readonly usedRequests: number; readonly maxDurationMs: number };
}
export interface CaptureService { capture(input: unknown): Promise<CaptureResult> }
