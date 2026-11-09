import { DomainError, ERROR_CATALOG } from "../domain/errors.ts";
import type { Environment } from "../config/environment.ts";

export const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /authorization|token|secret|password|passwd|apikey|credential|cookie|privatekey|stack|cause/.test(normalized)
    || /^(auth|env|environment|config|notionapi)$/.test(normalized);
}

export function createRedactor(environment: Environment = {}, extraSecrets: readonly string[] = []) {
  const secrets = new Set(extraSecrets.filter(Boolean));
  for (const [key, value] of Object.entries(environment)) {
    if (isSensitiveKey(key) && value) {
      secrets.add(value);
      if (value.trim()) secrets.add(value.trim());
    }
  }
  const variants = new Set<string>();
  for (const secret of secrets) {
    variants.add(secret);
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      // Malformed Unicode must not prevent safe failure diagnostics.
    }
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  const knownSecrets = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);

  function redactText(value: string): string {
    let safe = value;
    for (const secret of knownSecrets) safe = safe.replaceAll(secret, REDACTED);
    safe = safe.replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+/gi, "$1 " + REDACTED);
    safe = safe.replace(/\b(?:secret_|ntn_|sk[-_])[a-z0-9_-]+\b/gi, REDACTED);
    return safe.replace(/\b(authorization|notion[_-]?api|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|password|secret)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=" + REDACTED);
  }

  function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (typeof value === "string") return redactText(value);
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
    if (typeof value !== "object") return "[Unsupported]";
    if (value instanceof Error) {
      const code = value instanceof DomainError ? value.code : "INTERNAL_ERROR";
      return { code, message: ERROR_CATALOG[code].message };
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[Binary]";
    if (value instanceof Map || value instanceof Set) return "[Collection]";
    if (depth >= 10) return "[Truncated]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      const properties = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = properties[String(index)];
          return descriptor && "value" in descriptor ? sanitize(descriptor.value, seen, depth + 1) : "[Accessor]";
        });
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(properties)) {
        if (!descriptor.enumerable) continue;
        result[redactText(key)] = isSensitiveKey(key) ? REDACTED
          : "value" in descriptor ? sanitize(descriptor.value, seen, depth + 1) : "[Accessor]";
      }
      return result;
    } catch {
      return "[Unserializable]";
    }
  }

  return Object.freeze({
    text: redactText,
    value: (value: unknown): unknown => sanitize(value, new WeakSet(), 0),
  });
}
