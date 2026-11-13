import type { DatabaseKey, SchemaIssue } from "./notion-schema.ts";

export const ERROR_CATALOG = {
  METHOD_NOT_ALLOWED: { message: "The HTTP method is not supported.", httpStatus: 405, retryable: false },
  PAYLOAD_TOO_LARGE: { message: "The payload exceeds the size limit.", httpStatus: 413, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { message: "The request content type is not supported.", httpStatus: 415, retryable: false },
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

export interface ConfigurationIssue {
  readonly field: string;
  readonly code: string;
}

export class ConfigurationError extends DomainError {
  readonly invalidFields: readonly string[];
  readonly configurationIssues: readonly ConfigurationIssue[];

  constructor(invalidFields: readonly string[], issues: readonly ConfigurationIssue[] = []) {
    super("CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
    this.invalidFields = Object.freeze([...new Set(invalidFields)]);
    // Retain only application field names and validator codes, never raw issues.
    this.configurationIssues = Object.freeze(issues.map(({ field, code }) => Object.freeze({ field, code })));
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
  readonly validation?: readonly ValidationIssue[];
}

export interface ValidationIssue {
  readonly field: string;
  readonly allowedValues?: readonly string[];
}

export class RequestValidationError extends DomainError {
  readonly validation: readonly ValidationIssue[];

  constructor(validation: readonly ValidationIssue[]) {
    super("VALIDATION_ERROR");
    this.name = "RequestValidationError";
    this.validation = Object.freeze(validation.map((issue) => Object.freeze({ ...issue })));
  }
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
    ...(error instanceof RequestValidationError ? { validation: error.validation } : {}),
  });
}
