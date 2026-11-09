export const DATABASE_KEYS = ["projects", "subprojects", "knowledge"] as const;
export type DatabaseKey = typeof DATABASE_KEYS[number];
export const DATABASE_LABELS = { projects: "Projects", subprojects: "Subprojects", knowledge: "Knowledge" } as const;

export type PropertyType = "title" | "rich_text" | "url" | "select" | "multi_select" | "created_time" | "last_edited_time" | "relation";
export interface ExpectedProperty {
  readonly name: ApprovedPropertyName;
  readonly type: PropertyType;
  readonly options?: readonly string[];
  readonly relation?: DatabaseKey;
}
export type ApprovedPropertyName = "Name" | "Description" | "Repository URL" | "Status" | "Primary Stack" | "Created" | "Last Updated" | "Type" | "Repository Path" | "Project" | "Verification" | "Context / Environment" | "Files / Paths" | "Source URL" | "Tags" | "Subproject";

export interface DatabaseMetadata {
  readonly id: string;
  readonly dataSourceIds: readonly string[];
}
export interface PropertyMetadata {
  readonly id: string;
  readonly type: string;
  readonly options?: readonly string[];
  readonly relation?: Readonly<{ databaseId?: string; dataSourceId?: string }>;
}
export interface DataSourceMetadata {
  readonly id: string;
  readonly databaseId: string;
  readonly properties: Readonly<Record<string, PropertyMetadata>>;
}

// This is the only read capability exposed; SDK objects and write methods never escape.
export interface NotionSchemaReader {
  retrieveDatabase(database: DatabaseKey, id: string): Promise<DatabaseMetadata>;
  retrieveDataSource(database: DatabaseKey, id: string): Promise<DataSourceMetadata>;
}

export type SchemaIssueReason = "INVALID_METADATA" | "DATABASE_ID_MISMATCH" | "DATA_SOURCE_COUNT" | "INVALID_DATA_SOURCE" | "UNEXPECTED_DATA_SOURCE" | "DUPLICATE_DATA_SOURCE" | "WRONG_PARENT" | "MISSING_PROPERTY" | "WRONG_TYPE" | "OPTIONS_CHANGED" | "RELATION_TARGET";
export interface SchemaIssue {
  readonly database: DatabaseKey;
  readonly property?: ApprovedPropertyName;
  readonly reason: SchemaIssueReason;
}
export interface ValidatedProperty {
  readonly id: string;
  readonly name: ApprovedPropertyName;
  readonly type: PropertyType;
  readonly options?: readonly string[];
  readonly relation?: Readonly<{ database: DatabaseKey; databaseId: string; dataSourceId: string }>;
}
export interface ValidatedDatabase {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly properties: Readonly<Record<string, ValidatedProperty>>;
}
export type ValidatedSchema = Readonly<Record<DatabaseKey, ValidatedDatabase>>;
export interface NotionSchemaIntegration {
  initialize(): Promise<ValidatedSchema>;
}

// Notion IDs may be returned with or without hyphens; compare canonical UUIDs.
export function canonicalNotionId(value: string): string | undefined {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)) return undefined;
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{12}[1-8][0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(compact)) return undefined;
  return compact.slice(0, 8) + "-" + compact.slice(8, 12) + "-" + compact.slice(12, 16) + "-" + compact.slice(16, 20) + "-" + compact.slice(20);
}
