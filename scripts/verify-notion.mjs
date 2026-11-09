import { initializeApplication } from "../src/app.ts";
import { ConfigurationError, mapError } from "../src/domain/errors.ts";
import { withCorrelationId, getCorrelationId } from "../src/observability/context.ts";

// Process environment only. No dotenv, file loading, queries or schema writes.
await withCorrelationId(async () => {
  try {
    const application = await initializeApplication(process.env);
    const dataSources = Object.fromEntries(Object.entries(application.schemas).map(([name, schema]) => [name, schema.dataSourceId]));
    const properties = Object.fromEntries(Object.entries(application.schemas).map(([name, schema]) => [name, Object.keys(schema.properties).length]));
    process.stdout.write(JSON.stringify({ status: "PASS", apiVersion: application.config.notion.apiVersion, dataSources, properties }) + "\n");
  } catch (error) {
    const safe = mapError(error, getCorrelationId() ?? "unavailable");
    const blocked = error instanceof ConfigurationError;
    process.stderr.write(JSON.stringify({
      status: blocked ? "BLOCKED" : "FAIL",
      error: safe,
      ...(blocked ? { invalidFields: error.invalidFields, action: "Supply these variables through the process environment. The repository .env is never loaded." } : {}),
    }) + "\n");
    process.exitCode = blocked ? 2 : 1;
  }
});
