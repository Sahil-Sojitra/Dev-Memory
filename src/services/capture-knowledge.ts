import { validateCapture, PartialWriteError, WriteConfirmedAfterDeadlineError } from "../domain/capture-knowledge.ts";
import type { CaptureWriter, CaptureService, CreatedKnowledge } from "../domain/capture-knowledge.ts";
import type { ProjectContextRepository, RequestBudget } from "../domain/project-context.ts";
import { DomainError } from "../domain/errors.ts";
import { createRequestBudget } from "./request-budget.ts";
import { validateProjectScope } from "./project-scope.ts";
import { markdownToBlocks } from "./markdown-capture.ts";

const normalizeTitle = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
export function createCaptureService(writer: CaptureWriter, repository: ProjectContextRepository,
  budgetFactory: () => RequestBudget = createRequestBudget, onKnowledgeChanged?: () => void): CaptureService {
  const notify = () => { try { onKnowledgeChanged?.(); } catch { /* Cache maintenance cannot change write outcomes. */ } };
  return Object.freeze({ async capture(input: unknown) {
    const value = validateCapture(input);
    const blocks = markdownToBlocks(value.content); // All local validation precedes I/O.
    const batches = Array.from({ length: Math.ceil(blocks.length / 100) }, (_, index) => blocks.slice(index * 100, (index + 1) * 100));
    const budget = budgetFactory();
    let created: CreatedKnowledge | undefined;
    let confirmedBatches = 0;
    let confirmedBlocks = 0;
    try {
      await validateProjectScope(repository, value, budget);
      let scanned = 0;
      let matches = 0;
      let complete = false;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      const ids = new Set<string>();
      while (scanned < 500) {
        const page = await budget.run(() => repository.listKnowledge({ projectId: value.projectId, limit: Math.min(100, 500 - scanned), ...(cursor ? { cursor } : {}) }, budget));
        for (const entry of page.items) {
          if (ids.has(entry.id)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
          ids.add(entry.id); scanned++;
          if (normalizeTitle(entry.name) === normalizeTitle(value.title)) matches++;
        }
        if (!page.hasMore) { complete = true; break; }
        if (!page.nextCursor || cursors.has(page.nextCursor)) throw new DomainError("DEPENDENCY_UNAVAILABLE");
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      const bindings = await budget.run(() => writer.prepare(budget));
      budget.assertActive();
      if (budget.maxRequests - budget.used < 1 + batches.length) throw new DomainError("REQUEST_BUDGET_EXCEEDED");
      // Mutations are wrapped inside the repository so their failure can be
      // classified as unconfirmed. Do not race the entire workflow: confirmed
      // creation must remain available for recovery even when append expires.
      created = await writer.create(value, bindings, budget);
      notify();
      for (const batch of batches) {
        await writer.append(created, batch, budget);
        confirmedBatches++; confirmedBlocks += batch.length;
      }
      notify(); // Also invalidate searches that raced the create/append window.
      budget.assertActive();
      const warnings: ("DUPLICATE_TITLE" | "DUPLICATE_CHECK_INCOMPLETE")[] = [];
      if (matches) warnings.push("DUPLICATE_TITLE");
      if (!complete) warnings.push("DUPLICATE_CHECK_INCOMPLETE");
      return Object.freeze({ entry: Object.freeze({ ...created, verification: value.verification }),
        body: Object.freeze({ complete: true as const, blocksWritten: confirmedBlocks, batchesWritten: confirmedBatches }),
        warnings: Object.freeze(warnings), duplicateCheck: Object.freeze({ complete, scanned, matches }),
        requestBudget: Object.freeze({ maxRequests: budget.maxRequests, usedRequests: budget.used, maxDurationMs: budget.maxDurationMs }),
      });
    } catch (error) {
      if (created || (error instanceof DomainError && error.code === "WRITE_OUTCOME_UNKNOWN")) notify();
      if (created && confirmedBatches === batches.length) throw new WriteConfirmedAfterDeadlineError({
        pageId: created.id, url: created.url, confirmedBatches, totalBatches: batches.length, confirmedBlocks,
        totalBlocks: blocks.length, bodyComplete: true, doNotRetryCapture: true,
      });
      if (created) throw new PartialWriteError({ pageId: created.id, url: created.url, confirmedBatches, totalBatches: batches.length,
        confirmedBlocks, totalBlocks: blocks.length, bodyComplete: confirmedBlocks === blocks.length,
        failedBatchOutcome: error instanceof DomainError && error.code === "REQUEST_BUDGET_EXCEEDED" ? "not_sent"
          : error instanceof DomainError && error.code === "WRITE_OUTCOME_UNKNOWN" ? "unknown" : "rejected",
        doNotRetryCapture: true,
      });
      throw error;
    } finally { budget.dispose(); }
  } });
}
