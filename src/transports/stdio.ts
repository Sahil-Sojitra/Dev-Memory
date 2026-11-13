import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { initializeApplication } from "../app.ts";
import type { ApplicationOptions } from "../app.ts";
import type { Environment } from "../config/environment.ts";
import { ConfigurationError, DomainError, mapError } from "../domain/errors.ts";
import { getCorrelationId, withCorrelationId } from "../observability/context.ts";
import { createLogger } from "../observability/logger.ts";

export async function startStdio(environment: Environment, options: ApplicationOptions = {}) {
  const application = await initializeApplication(environment, options);
  if (application.config.transport !== "stdio") throw new ConfigurationError(["MCP_TRANSPORT"]);
  const handle = serveStdio(application.createServer, {
    maxSubscriptions: 0,
    onerror(error) {
      application.logger.error("stdio_transport_failed", { error: mapError(error, getCorrelationId() ?? "unavailable") });
    },
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= handle.close().finally(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      application.logger.info("stdio_closed");
    });
    return closing;
  };
  const onEnd = () => { void close().catch(onCloseError); };
  const onCloseError = () => {
    process.exitCode = 1;
    application.logger.error("stdio_shutdown_failed", { error: mapError(new DomainError("INTERNAL_ERROR"), getCorrelationId() ?? "unavailable") });
  };
  const onSignal = () => {
    // Bound shutdown even if an upstream request is stuck. Normal EOF is handled
    // by the SDK; signal shutdown releases the stdio transport and its requests.
    const timer = setTimeout(() => process.exit(1), 2_000);
    timer.unref();
    // Keep the unref'd guard after close: an upstream fetch may still own a
    // socket even after MCP has aborted its handler. It must not delay shutdown.
    void close().then(() => { process.exitCode = 0; }, onCloseError);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onEnd);
  process.stdin.once("close", onEnd);
  application.logger.info("stdio_ready");
  return Object.freeze({ close });
}

export async function runStdio(environment: Environment): Promise<number> {
  return withCorrelationId(async () => {
    try {
      await startStdio(environment);
      return 0;
    } catch (error) {
      const logger = createLogger({ environment });
      logger.error("stdio_startup_failed", {
        error: mapError(error, getCorrelationId() ?? "unavailable"),
        ...(error instanceof ConfigurationError ? { invalidFields: error.invalidFields } : {}),
      });
      return 1;
    }
  });
}
