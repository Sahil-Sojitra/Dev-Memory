import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage<Readonly<{ correlationId: string }>>();
const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createCorrelationId(candidate?: string): string {
  return candidate && correlationPattern.test(candidate) ? candidate : randomUUID();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function withCorrelationId<T>(operation: () => T, candidate?: string): T {
  return storage.run(Object.freeze({ correlationId: createCorrelationId(candidate) }), operation);
}
