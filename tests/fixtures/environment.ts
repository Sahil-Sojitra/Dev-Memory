import type { Environment } from "../../src/config/environment.ts";
import { createHash } from "node:crypto";

export const FAKE_NOTION_TOKEN = "ntn_synthetic_fixture_token_not_a_real_credential";
export const FAKE_BEARER_TOKEN = "synthetic-remote-bearer-token-32-characters";
export const FAKE_BEARER_SHA256 = createHash("sha256").update(FAKE_BEARER_TOKEN).digest("hex");
export const FAKE_NEXT_TOKEN = "synthetic-next-remote-bearer-token-32-characters";
export const FAKE_NEXT_SHA256 = createHash("sha256").update(FAKE_NEXT_TOKEN).digest("hex");
export const validEnvironment = Object.freeze({
  NODE_ENV: "test",
  NOTION_API: FAKE_NOTION_TOKEN,
  NOTION_PROJECTS_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
  NOTION_SUBPROJECTS_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
  NOTION_KNOWLEDGE_DATABASE_ID: "33333333-3333-4333-8333-333333333333",
}) satisfies Environment;

export const validHttpEnvironment = Object.freeze({
  ...validEnvironment, MCP_TRANSPORT: "http", MCP_BEARER_TOKEN_SHA256: FAKE_BEARER_SHA256,
  MCP_PUBLIC_URL: "https://memory.example.test/api/mcp",
}) satisfies Environment;
