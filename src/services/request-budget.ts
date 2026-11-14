import { DomainError } from "../domain/errors.ts";
import type { RequestBudget } from "../domain/project-context.ts";

export const CONTEXT_MAX_REQUESTS = 20;
export const CONTEXT_MAX_DURATION_MS = 30_000;

export function createRequestBudget(maxRequests = CONTEXT_MAX_REQUESTS, maxDurationMs = CONTEXT_MAX_DURATION_MS): RequestBudget {
  const started = performance.now();
  const controller = new AbortController();
  let used = 0;
  let disposed = false;
  const failure = () => new DomainError("REQUEST_BUDGET_EXCEEDED");
  const expire = () => { if (!controller.signal.aborted) controller.abort(failure()); };
  const timer = setTimeout(expire, maxDurationMs);
  timer.unref();

  function assertActive(): void {
    // Also check the monotonic clock: a busy event loop can delay the timer.
    if (performance.now() - started >= maxDurationMs) expire();
    if (disposed || controller.signal.aborted) throw failure();
  }

  return Object.freeze({
    maxRequests, maxDurationMs, signal: controller.signal,
    get used() { return used; },
    assertActive,
    consume() {
      assertActive();
      if (used >= maxRequests) throw failure();
      used++;
    },
    run<T>(operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        try { assertActive(); } catch (error) { reject(error); return; }
        const cleanup = () => controller.signal.removeEventListener("abort", aborted);
        const aborted = () => { cleanup(); reject(failure()); };
        controller.signal.addEventListener("abort", aborted, { once: true });
        // Both continuations stay attached after cancellation. Late successes
        // cannot escape; late failures are observed rather than left unhandled.
        Promise.resolve().then(() => { assertActive(); return operation(); }).then((value) => {
          cleanup();
          try { assertActive(); resolve(value); } catch (error) { reject(error); }
        }, (error: unknown) => {
          cleanup();
          try { assertActive(); } catch (expired) { reject(expired); return; }
          reject(error);
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      // Cancel any orphaned work left by an earlier SDK timeout as well.
      expire();
    },
  });
}
