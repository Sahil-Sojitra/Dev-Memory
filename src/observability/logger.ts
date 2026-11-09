import pino from "pino";
import type { DestinationStream } from "pino";
import type { Environment } from "../config/environment.ts";
import { createCorrelationId, getCorrelationId } from "./context.ts";
import { createRedactor } from "./redaction.ts";

const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Level = typeof levels[number];
type Fields = Readonly<Record<string, unknown>>;
type LogMethod = (event: string, fields?: Fields) => void;

export type AppLogger = Readonly<Record<Level, LogMethod> & {
  child(fields: Fields): AppLogger;
}>;

interface LoggerOptions {
  readonly level?: Level | "silent";
  readonly environment?: Environment;
  readonly secrets?: readonly string[];
  readonly destination?: DestinationStream;
  readonly correlationId?: string;
}

// Do not expose raw Pino methods: sanitize events, fields and child bindings uniformly.
export function createLogger(options: LoggerOptions = {}): AppLogger {
  const redact = createRedactor(options.environment ?? process.env, options.secrets);
  const fallbackId = createCorrelationId(options.correlationId);
  const root = pino({
    level: options.level ?? "info",
    base: { service: "devmemory" },
    // Values have already been sanitized; do not re-expand them as raw errors.
    serializers: { err: (value: unknown) => value },
  }, options.destination ?? process.stderr);

  function wrap(bindings: Record<string, unknown> = {}): AppLogger {
    const methods = Object.fromEntries(levels.map((level) => [
      level,
      (event: string, fields: Fields = {}) => {
        const safeFields = redact.value(fields) as Record<string, unknown>;
        root[level]({ ...bindings, ...safeFields, correlationId: redact.text(getCorrelationId() ?? fallbackId) }, redact.text(event));
      },
    ])) as Record<Level, LogMethod>;
    return Object.freeze({
      ...methods,
      child(fields: Fields) {
        return wrap({ ...bindings, ...redact.value(fields) as Record<string, unknown> });
      },
    });
  }

  return wrap();
}
