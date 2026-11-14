import type { RequestBudget } from "../../domain/project-context.ts";

export function cancelNotionBody(response: Response): void {
  // A late fetch result must not leave its body open. Cancellation is best effort
  // and must not block the deadline on a non-cooperative stream implementation.
  try { void response.body?.cancel().catch(() => {}); } catch { /* Already locked/closed. */ }
}

export async function readNotionBody(response: Response, budget: RequestBudget): Promise<string> {
  try { budget.assertActive(); }
  catch (error) { cancelNotionBody(response); throw error; }
  // Custom fetch adapters may expose text() without a ReadableStream. The
  // deadline still rejects their late result even when they cannot be aborted.
  if (!response.body) return budget.run(() => response.text());
  const reader = response.body.getReader();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
  };
  budget.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await budget.run(async () => {
      const decoder = new TextDecoder();
      const parts: string[] = [];
      for (;;) {
        const chunk = await reader.read();
        // Even if cancellation races a resolved read, do not append late data.
        budget.assertActive();
        if (chunk.done) break;
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      budget.assertActive();
      return parts.join("");
    });
  } finally {
    budget.signal.removeEventListener("abort", cancel);
    if (budget.signal.aborted) cancel();
    try { reader.releaseLock(); } catch { /* An adapter may retain a pending read. */ }
  }
}
