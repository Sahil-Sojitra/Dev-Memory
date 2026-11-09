import type { DatabaseKey, SchemaIssue } from "./notion-schema.ts";

export const ERROR_CATALOG = {
  SCHEMA_DRIFT: { message: "The Notion schema does not match the approved schema. Check the identified database and property.", httpStatus: 503, retryable: false },
  CONFIGURATION_ERROR: { message: "Application configuration is invalid.", httpStatus: 500, retryable: false },
  VALIDATION_ERROR: { message: "The request is invalid.", httpStatus: 400, retryable: false },
  UNAUTHORIZED: { message: "Authentication is required.", httpStatus: 401, retryable: false },
  FORBIDDEN: { message: "Access is forbidden.", httpStatus: 403, retryable: false },
  NOT_FOUND: { message: "The requested resource was not found.", httpStatus: 404, retryable: false },
  CONFLICT: { message: "The request conflicts with the current state.", httpStatus: 409, retryable: false },
  RATE_LIMITED: { message: "The service is temporarily rate limited.", httpStatus: 429, retryable: true },
  DEPENDENCY_UNAVAILABLE: { message: "A required service is temporarily unavailable.", httpStatus: 503, retryable: true },
  TIMEOUT: { message: "The operation timed out.", httpStatus: 504, retryable: true },
  INTERNAL_ERROR: { message: "An unexpected error occurred.", httpStatus: 500, retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, options?: ErrorOptions) {
    super(ERROR_CATALOG[code].message, options);
    this.name = "DomainError";
    this.code = code;
  }
}

export class ConfigurationError extends DomainError {
  readonly invalidFields: readonly string[];

  constructor(invalidFields: readonly string[]) {
    super("CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
    this.invalidFields = Object.freeze([...new Set(invalidFields)]);
  }
}

export interface SafeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly database?: DatabaseKey;
  readonly issues?: readonly SchemaIssue[];
}

export class SchemaDriftError extends DomainError {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super("SCHEMA_DRIFT");
    this.name = "SchemaDriftError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export class NotionIntegrationError extends DomainError {
  readonly database: DatabaseKey;

  constructor(code: ErrorCode, database: DatabaseKey) {
    super(code);
    this.name = "NotionIntegrationError";
    this.database = database;
  }
}

// Public messages come only from this catalog, never vendor errors or causes.
export function mapError(error: unknown, correlationId: string): SafeError {
  const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  const definition = ERROR_CATALOG[code];
  return Object.freeze({
    code, ...definition, correlationId,
    ...(error instanceof SchemaDriftError ? { issues: error.issues } : {}),
    ...(error instanceof NotionIntegrationError ? { database: error.database } : {}),
  });
}
