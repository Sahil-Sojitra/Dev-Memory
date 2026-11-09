import type { AppConfig } from "../config/environment.ts";
import { SchemaDriftError } from "../domain/errors.ts";
import { DATABASE_KEYS, canonicalNotionId } from "../domain/notion-schema.ts";
import type { DatabaseKey, ExpectedProperty, NotionSchemaIntegration, NotionSchemaReader, SchemaIssue, ValidatedDatabase, ValidatedProperty, ValidatedSchema } from "../domain/notion-schema.ts";
import { NOTION_SCHEMA } from "../domain/schema-map.ts";

function sameId(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && canonicalNotionId(actual) === canonicalNotionId(expected);
}

export function createNotionSchemaIntegration(config: AppConfig["notion"], reader: NotionSchemaReader): NotionSchemaIntegration {
  let initialization: Promise<ValidatedSchema> | undefined;

  async function initialize(): Promise<ValidatedSchema> {
    const sources = {} as Record<DatabaseKey, string>;
    const resolutionIssues: SchemaIssue[] = [];
    const metadata = await Promise.all(DATABASE_KEYS.map(async (database) => ({
      database, metadata: await reader.retrieveDatabase(database, config.databases[database]),
    })));
    for (const { database, metadata: live } of metadata) {
      if (!sameId(live.id, config.databases[database])) resolutionIssues.push({ database, reason: "DATABASE_ID_MISMATCH" });
      if (live.dataSourceIds.length !== 1) {
        resolutionIssues.push({ database, reason: "DATA_SOURCE_COUNT" });
        continue;
      }
      const source = canonicalNotionId(live.dataSourceIds[0] ?? "");
      if (!source) {
        resolutionIssues.push({ database, reason: "INVALID_DATA_SOURCE" });
        continue;
      }
      sources[database] = source;
      const expectedSource = config.dataSources[database];
      if (expectedSource && !sameId(source, expectedSource)) resolutionIssues.push({ database, reason: "UNEXPECTED_DATA_SOURCE" });
    }
    if (resolutionIssues.length) throw new SchemaDriftError(resolutionIssues);
    if (new Set(Object.values(sources)).size !== DATABASE_KEYS.length) {
      throw new SchemaDriftError(DATABASE_KEYS.map((database) => ({ database, reason: "DUPLICATE_DATA_SOURCE" })));
    }

    const schemas = await Promise.all(DATABASE_KEYS.map(async (database) => ({
      database, schema: await reader.retrieveDataSource(database, sources[database]),
    })));
    const issues: SchemaIssue[] = [];
    const result = {} as Record<DatabaseKey, ValidatedDatabase>;
    for (const { database, schema } of schemas) {
      if (!sameId(schema.id, sources[database])) issues.push({ database, reason: "UNEXPECTED_DATA_SOURCE" });
      if (!sameId(schema.databaseId, config.databases[database])) issues.push({ database, reason: "WRONG_PARENT" });
      const mapped: Record<string, ValidatedProperty> = {};
      const expected: Readonly<Record<string, ExpectedProperty>> = NOTION_SCHEMA[database];
      for (const [applicationName, property] of Object.entries(expected)) {
        const live = Object.hasOwn(schema.properties, property.name) ? schema.properties[property.name] : undefined;
        if (!live) {
          issues.push({ database, property: property.name, reason: "MISSING_PROPERTY" });
          continue;
        }
        if (live.type !== property.type) {
          issues.push({ database, property: property.name, reason: "WRONG_TYPE" });
          continue;
        }
        if (property.options) {
          const actual = live.options ?? [];
          if (actual.length !== property.options.length || new Set(actual).size !== actual.length
            || property.options.some((option) => !actual.includes(option))) {
            issues.push({ database, property: property.name, reason: "OPTIONS_CHANGED" });
          }
        }
        if (property.relation) {
          const target = property.relation;
          const relation = live.relation;
          if (!relation || (!relation.databaseId && !relation.dataSourceId)
            || (relation.databaseId !== undefined && !sameId(relation.databaseId, config.databases[target]))
            || (relation.dataSourceId !== undefined && !sameId(relation.dataSourceId, sources[target]))) {
            issues.push({ database, property: property.name, reason: "RELATION_TARGET" });
          }
        }
        mapped[applicationName] = Object.freeze({
          id: live.id, name: property.name, type: property.type,
          ...(property.options ? { options: property.options } : {}),
          ...(property.relation ? { relation: Object.freeze({
            database: property.relation,
            databaseId: config.databases[property.relation],
            dataSourceId: sources[property.relation],
          }) } : {}),
        });
      }
      result[database] = Object.freeze({ databaseId: config.databases[database], dataSourceId: sources[database], properties: Object.freeze(mapped) });
    }
    if (issues.length) throw new SchemaDriftError(issues);
    return Object.freeze(result);
  }

  return Object.freeze({
    initialize() {
      initialization ??= initialize().catch((error: unknown) => {
        initialization = undefined;
        throw error;
      });
      return initialization;
    },
  });
}
