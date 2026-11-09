import type { Environment } from "../../src/config/environment.ts";

export const FAKE_NOTION_TOKEN = "ntn_synthetic_fixture_token_not_a_real_credential";
export const FAKE_BEARER_TOKEN = "synthetic-remote-bearer-token-32-characters";
export const validEnvironment = Object.freeze({
  NODE_ENV: "test",
  NOTION_API: FAKE_NOTION_TOKEN,
  NOTION_PROJECTS_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
  NOTION_SUBPROJECTS_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
  NOTION_KNOWLEDGE_DATABASE_ID: "33333333-3333-4333-8333-333333333333",
}) satisfies Environment;
