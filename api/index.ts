import { createHttpApplication } from "../src/transports/http.ts";

// No sockets or eager Notion calls at import time. The closure caches only
// validated application services; every MCP exchange gets a fresh SDK context.
const application = createHttpApplication();
export default { fetch: application.fetch };
