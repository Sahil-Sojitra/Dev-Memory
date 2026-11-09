# DevMemory

DevMemory is a Node.js + TypeScript modular monolith for a planned Notion-backed
MCP service. Notion remains the only source of truth.

KAN-6/KAN-7 provide configuration, safe errors, correlation IDs and stderr logging.
KAN-8 adds read-only Notion metadata retrieval, data-source resolution, and startup
schema validation. Live KAN-8 schema verification passed in the user's terminal;
the result is recorded in the schema documentation. MCP listeners, business tools
and record operations are not implemented.
**Vercel hosted deployment is NOT YET VERIFIED.**

## Development

Use Node.js **24.22.1** (see `.nvmrc`) and npm **11.19.1**. The system Node 22
runtime does not meet this project's engine requirement. Dependencies use exact
approved pins and npm overrides, with the verified KAN-4 dependency graph retained.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run check` runs typecheck, lint, tests, and build together. `npm run dev`
runs the foundation entry in Node's TypeScript watch mode; `node dist/index.js`
runs its compiled form. Startup validates configuration and all three live Notion
schemas before logging readiness to stderr and exiting. It starts no MCP or HTTP
listener. Invalid metadata, access failures or schema drift prevent readiness.
In watch mode, Node remains available to restart the entry when files change.

Lint uses the approved TypeScript compiler API and Node built-ins, without adding
unapproved dependencies. It checks formatting, explicit `any`, stdout/console
diagnostics in source, domain boundaries, and Notion SDK import boundaries.

The project `.npmrc` enforces exact saves, strict engine/peer checks, and disabled
dependency lifecycle scripts. The verified graph installs and tests with scripts
disabled. No vulnerability-audit result is claimed.

## Configuration

[.env.example](.env.example) documents variable names and empty credential
placeholders. Supply values through the process environment or your hosting
platform. **No script automatically loads the repository `.env`.** Tests use
synthetic environment objects and a separate Vite environment directory.

All modes require `NOTION_API` and the three distinct
`NOTION_*_DATABASE_ID` UUIDs. Data sources are resolved from database metadata.
Optional `NOTION_*_DATA_SOURCE_ID` values assert the expected resolved IDs; omit
them if unused rather than supplying blank strings. `NOTION_API_VERSION` is fixed to
`2025-09-03`. `NODE_ENV` defaults to `development`, `LOG_LEVEL` to `info`,
and `MCP_TRANSPORT` to `stdio`.

For `MCP_TRANSPORT=http`, also supply a separate `MCP_BEARER_TOKEN` of at least
32 non-whitespace characters and an HTTPS `MCP_PUBLIC_URL` without credentials,
query, or fragment. Optional `MCP_ALLOWED_ORIGINS` is a comma-separated set of
HTTPS origins. Validated HTTP configuration derives the allowed host from the
public URL. No port, server, routes, or bearer middleware is started yet.

`npm run verify:notion` performs the same read-only schema gate and reports IDs and
property counts. It never loads `.env` or queries records. Missing process
configuration exits 2 (blocked), API/schema failure exits 1, and success exits 0.
The user-run command passed for all three databases and all 24 required properties;
see the [KAN-8 schema map and verification evidence](docs/notion-schema-validation.md).

Configuration failures identify invalid variable names without retaining input
values. Public error mapping uses fixed messages and never exposes vendor errors,
stacks, or causes. The Pino wrapper redacts credential keys recursively and known
secret environment values in events, fields, and child bindings. It also masks
common bearer/API-token text patterns. For programmatically supplied secrets,
register them through the logger's `secrets` option. Avoid logging business-tool
payloads; automatic detection cannot identify every unknown arbitrary secret.

Async-local correlation IDs keep concurrent operations separate. Incoming IDs
must be UUIDs; invalid IDs are replaced. Logging defaults to stderr so stdout
remains available for a future stdio transport.

## Repository structure

```text
src/
  app.ts                     Startup configuration and live schema gate
  index.ts                   Native TypeScript / compiled entry
  config/                    Zod environment validation
  domain/                    Stable errors, application schema types and exact map
  observability/             Correlation context, redaction, Pino logging
  integrations/notion/        Reusable read-only SDK metadata adapter
  services/                  Data-source resolution and schema validation
  transports/                Reserved stdio / stateless HTTP boundary
scripts/lint.mjs              Static checks using TypeScript and Node built-ins
scripts/verify-notion.mjs     Read-only metadata verification; process env only
tests/                       Synthetic configuration, error, logging, startup tests
docs/                        Decisions and verification history
```

Future Notion SDK imports must stay in `src/integrations/notion/`. No Express,
frontend, REST routes, Docker, Azure configuration, additional database, queue,
vector database, or embeddings are included.

## Documentation and evidence

- [Architecture decisions](docs/architecture-decisions.md)
- [Dependency baseline and all npm overrides](docs/dependency-baseline.md)
- [MCP compatibility spike results and limitations](docs/mcp-compatibility-spike.md)
- [Notion schema validation and verification results](docs/notion-schema-validation.md)

KAN-4 and the local/Antigravity CLI parts of KAN-5 passed in temporary directories.
The production lockfile changes only the verified baseline's root project
metadata; third-party package entries retain the original graph. Hosted HTTPS,
deployment, cold-start, streaming, and timeout behavior still require a disposable
Vercel deployment test.
