import type { DestinationStream } from "pino";
import { loadConfig } from "./config/environment.ts";
import type { Environment } from "./config/environment.ts";
import { ConfigurationError, mapError } from "./domain/errors.ts";
import { getCorrelationId, withCorrelationId } from "./observability/context.ts";
import { createLogger } from "./observability/logger.ts";
import { createNotionClient } from "./integrations/notion/client.ts";
import { createNotionSchemaIntegration } from "./services/notion-schema.ts";
import type { NotionSchemaReader } from "./domain/notion-schema.ts";
import type { ProjectRepository } from "./domain/projects.ts";
import { createProjectListingService } from "./services/projects.ts";
import { createMcpServer } from "./mcp/server.ts";

// Configuration-only helper retained for KAN-6 callers. Stdio uses initializeApplication.
export function runFoundation(environment: Environment, destination?: DestinationStream): number {
  return withCorrelationId(() => {
    try {
      const config = loadConfig(environment);
      const logger = createLogger({ level: config.logLevel, environment, ...(destination ? { destination } : {}) });
      logger.info("foundation_ready", {
        transport: config.transport,
        nodeEnv: config.nodeEnv,
        notionApiVersion: config.notion.apiVersion,
      });
      return 0;
    } catch (error) {
      const logger = createLogger({ environment, ...(destination ? { destination } : {}) });
      logger.error("foundation_configuration_failed", {
        error: mapError(error, getCorrelationId() ?? "unavailable"),
        ...(error instanceof ConfigurationError ? { invalidFields: error.invalidFields } : {}),
      });
      return 1;
    }
  });
}

export interface ApplicationOptions {
  readonly destination?: DestinationStream;
  readonly schemaReader?: NotionSchemaReader;
  readonly projectRepository?: ProjectRepository;
}

export async function initializeApplication(environment: Environment, options: ApplicationOptions = {}) {
  const config = loadConfig(environment);
  const logger = createLogger({ level: config.logLevel, environment, ...(options.destination ? { destination: options.destination } : {}) });
  let phase: "notion_client" | "notion_schema" | "project_services" = "notion_client";
  try {
    const client = createNotionClient(config.notion, {
      onMetadataFailure: (failure) => logger.error("notion_metadata_failed", { ...failure }),
    });
    const reader = options.schemaReader ?? client;
    const notion = createNotionSchemaIntegration(config.notion, reader);
    phase = "notion_schema";
    const schemas = await notion.initialize();
    logger.info("notion_schema_validated", { databases: 3, properties: 24 });
    phase = "project_services";
    const repository = options.projectRepository ?? client.createProjectRepository(schemas.projects);
    const projects = createProjectListingService(repository);
    return Object.freeze({ config, notion, schemas, logger, projects,
      createServer: () => createMcpServer({ projects, logger }),
    });
  } catch (error) {
    logger.error("application_initialization_failed", { phase, error: mapError(error, getCorrelationId() ?? "unavailable") });
    throw error;
  }
}

export async function runApplication(environment: Environment, options: ApplicationOptions = {}): Promise<number> {
  return withCorrelationId(async () => {
    try {
      const application = await initializeApplication(environment, options);
      const logger = createLogger({ level: application.config.logLevel, environment, ...(options.destination ? { destination: options.destination } : {}) });
      logger.info("application_ready", { transport: application.config.transport });
      return 0;
    } catch (error) {
      const logger = createLogger({ environment, ...(options.destination ? { destination: options.destination } : {}) });
      logger.error("application_startup_failed", {
        error: mapError(error, getCorrelationId() ?? "unavailable"),
        ...(error instanceof ConfigurationError ? { invalidFields: error.invalidFields } : {}),
      });
      return 1;
    }
  });
}
