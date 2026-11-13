import * as z from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigurationError } from "../domain/errors.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

const nonWhitespaceSecret = z.string().min(1).regex(/^\S+$/);
const nodeEnv = z.enum(["development", "test", "production"]);
const logLevel = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
const notionId = z.uuid().transform((value) => value.toLowerCase());
const sha256Digest = z.string().regex(/^[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());

const httpsEndpoint = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}).transform((value) => new URL(value).href);

const httpsOrigin = httpsEndpoint.refine((value) => new URL(value).pathname === "/")
  .transform((value) => new URL(value).origin);

const origins = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : value,
  z.array(httpsOrigin).default([]),
).transform((values) => [...new Set(values)]);

const common = z.object({
  NODE_ENV: nodeEnv.default("development"),
  LOG_LEVEL: logLevel.default("info"),
  NOTION_API: nonWhitespaceSecret,
  NOTION_API_VERSION: z.literal("2025-09-03").default("2025-09-03"),
  NOTION_PROJECTS_DATABASE_ID: notionId,
  NOTION_SUBPROJECTS_DATABASE_ID: notionId,
  NOTION_KNOWLEDGE_DATABASE_ID: notionId,
  // Optional assertions only: data sources are always resolved from databases.
  NOTION_PROJECTS_DATA_SOURCE_ID: notionId.optional(),
  NOTION_SUBPROJECTS_DATA_SOURCE_ID: notionId.optional(),
  NOTION_KNOWLEDGE_DATA_SOURCE_ID: notionId.optional(),
});

const schema = z.discriminatedUnion("MCP_TRANSPORT", [
  common.extend({ MCP_TRANSPORT: z.literal("stdio") }),
  common.extend({
    MCP_TRANSPORT: z.literal("http"),
    MCP_BEARER_TOKEN_SHA256: sha256Digest,
    MCP_BEARER_TOKEN_NEXT_SHA256: sha256Digest.optional(),
    // A remote server must never retain a configured plaintext bearer token.
    MCP_BEARER_TOKEN: z.never().optional(),
    MCP_PUBLIC_URL: httpsEndpoint,
    MCP_ALLOWED_ORIGINS: origins,
  }),
]).superRefine((value, context) => {
  const fields = ["NOTION_PROJECTS_DATABASE_ID", "NOTION_SUBPROJECTS_DATABASE_ID", "NOTION_KNOWLEDGE_DATABASE_ID"] as const;
  if (new Set(fields.map((field) => value[field])).size !== fields.length) {
    context.addIssue({ code: "custom", path: ["NOTION_PROJECTS_DATABASE_ID"], message: "Databases must be distinct." });
  }
  if (value.MCP_TRANSPORT === "http") {
    const notionDigest = createHash("sha256").update(value.NOTION_API).digest();
    for (const field of ["MCP_BEARER_TOKEN_SHA256", "MCP_BEARER_TOKEN_NEXT_SHA256"] as const) {
      const digest = value[field];
      if (digest && /^[0-9a-f]{64}$/.test(digest) && timingSafeEqual(notionDigest, Buffer.from(digest, "hex"))) {
        context.addIssue({ code: "custom", path: [field], message: "Separate credentials are required." });
      }
    }
  }
});

interface CommonConfig {
  readonly nodeEnv: z.infer<typeof nodeEnv>;
  readonly logLevel: z.infer<typeof logLevel>;
  readonly notion: Readonly<{
    apiToken: string;
    apiVersion: "2025-09-03";
    databases: Readonly<{ projects: string; subprojects: string; knowledge: string }>;
    dataSources: Readonly<{ projects: string | undefined; subprojects: string | undefined; knowledge: string | undefined }>;
  }>;
}

export type AppConfig = Readonly<CommonConfig & (
  { readonly transport: "stdio" } |
  { readonly transport: "http"; readonly http: Readonly<{
    bearerTokenSha256: string;
    nextBearerTokenSha256: string | undefined;
    publicUrl: string;
    allowedHosts: readonly string[];
    allowedOrigins: readonly string[];
  }> }
)>;

// Pure validation: no dotenv loading, filesystem reads, network access or env mutation.
export function loadConfig(environment: Environment = process.env): AppConfig {
  const result = schema.safeParse({ ...environment, MCP_TRANSPORT: environment.MCP_TRANSPORT ?? "stdio" });
  if (!result.success) {
    // Do not retain Zod input, issue messages, or the raw environment in the error.
    throw new ConfigurationError(result.error.issues.map((issue) => String(issue.path[0] ?? "CONFIGURATION")));
  }
  const value = result.data;
  const shared = {
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    notion: Object.freeze({
      apiToken: value.NOTION_API,
      apiVersion: value.NOTION_API_VERSION,
      databases: Object.freeze({
        projects: value.NOTION_PROJECTS_DATABASE_ID,
        subprojects: value.NOTION_SUBPROJECTS_DATABASE_ID,
        knowledge: value.NOTION_KNOWLEDGE_DATABASE_ID,
      }),
      dataSources: Object.freeze({
        projects: value.NOTION_PROJECTS_DATA_SOURCE_ID,
        subprojects: value.NOTION_SUBPROJECTS_DATA_SOURCE_ID,
        knowledge: value.NOTION_KNOWLEDGE_DATA_SOURCE_ID,
      }),
    }),
  };
  if (value.MCP_TRANSPORT === "stdio") return Object.freeze({ ...shared, transport: "stdio" });
  return Object.freeze({
    ...shared,
    transport: "http",
    http: Object.freeze({
      bearerTokenSha256: value.MCP_BEARER_TOKEN_SHA256,
      nextBearerTokenSha256: value.MCP_BEARER_TOKEN_NEXT_SHA256,
      publicUrl: value.MCP_PUBLIC_URL,
      allowedHosts: Object.freeze([new URL(value.MCP_PUBLIC_URL).host]),
      allowedOrigins: Object.freeze(value.MCP_ALLOWED_ORIGINS),
    }),
  });
}
