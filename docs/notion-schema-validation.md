# Notion integration and schema validation (KAN-8)

## Current verification status

The integration is implemented and tested with synthetic metadata using the real
approved SDK. **Live KAN-8 schema verification passed** in the user's PowerShell
terminal: `npm run verify:notion` reported PASS for all three data sources and all
24 required properties. This is user-supplied terminal evidence, not an agent-run
live request. The agent did not read `.env`, obtain the token, or rerun live calls.

The initial agent-side attempt was blocked by absent process configuration. After
the user supplied database IDs and refreshed the token through a masked terminal
prompt, the live verification passed. The repository `.env` is never loaded by
application code or tests. This result is separate from the earlier KAN-3 evidence.

Agent-run local verification on 9 November 2026 used Node 24.22.1 and npm 11.19.1.
The user's live output did not include its Node/npm versions.

| Check | Result |
|---|---|
| Clean npm ci with approved lockfile | PASS |
| Typecheck / lint / build | PASS / PASS / PASS |
| Full deterministic test suite | 180 tests passed in 5 files |
| Live read-only verification | PASS, user-run command; API version 2025-09-03 |
| Live resolved data sources | All three IDs below reconfirmed by the user-run result |

User-provided verification result (credentials and record contents are absent):

```json
{
  "status": "PASS",
  "apiVersion": "2025-09-03",
  "dataSources": {
    "projects": "6cb3353a-16fa-458f-bcad-470097268b40",
    "subprojects": "64e25db4-11f7-4e0c-b3d5-a70a2f1c5696",
    "knowledge": "87927b6e-7fe0-44cb-a977-22a62175d2a1"
  },
  "properties": { "projects": 7, "subprojects": 6, "knowledge": 11 }
}
```

The preceding `notion_schema_validated` event reported three databases and 24
properties with correlation ID `7c0be95f-4cfc-40af-b374-4b07cc7d76bb`. The command
completed without a schema-drift error. This validates metadata and the required
schema checks, not record creation, MCP serving, or Vercel deployment.

The deterministic suite uses only synthetic API responses. No live schema or
record writes occurred, no credentials were printed, and the repository .env was
not read or modified. No changes were staged or committed for KAN-8.

## Configuration and lifecycle

Required variables, supplied through the process environment:

- `NOTION_API`
- `NOTION_PROJECTS_DATABASE_ID`
- `NOTION_SUBPROJECTS_DATABASE_ID`
- `NOTION_KNOWLEDGE_DATABASE_ID`

Database IDs must be distinct UUIDs. Optional `NOTION_PROJECTS_DATA_SOURCE_ID`,
`NOTION_SUBPROJECTS_DATA_SOURCE_ID`, and `NOTION_KNOWLEDGE_DATA_SOURCE_ID` are
expected-ID assertions, not substitutes for database resolution. Omit unused
assertions rather than setting them to empty strings. All configuration passes
through the existing Zod validator. API version remains `2025-09-03`.

Each application instance creates one reusable `@notionhq/client@5.28.0` client,
then retrieves metadata for all three databases. Each must expose exactly one
valid, distinct data source. Startup retrieves those schemas, verifies their IDs
and parents, and validates the map below. Readiness is logged only after success.
Concurrent initialization shares one promise; successful results remain immutable
and cached for that application lifecycle. Failure does not retain a partial cache.
A new application instance revalidates the live schema.

The adapter uses a 10-second request timeout and at most two SDK retries, with
100 ms initial / 500 ms maximum retry delay. SDK payload logging is disabled.
KAN-8 allowed only metadata GETs and rejected redirects. KAN-9 extends that
same client with bounded, read-only Projects queries (POST /query), mapping
records to application-owned DTOs. Public interfaces never expose SDK objects
or write capabilities. The metadata-only reader retains its original surface.

The validated application context exposes cached schemas and an initialization
interface for services. KAN-8 introduced no MCP tools, listeners, REST routes,
record queries, or record write operations. KAN-9 adds the stdio server and
read-only project listing; see [its contract and evidence](local-mcp.md).

## Approved map from KAN-3

Exact names and types, transcribed from the successful read-only verification in
the earlier conversation. Fixtures are independently defined rather than generated
from the expected map.

| Database | Application field | Notion property | Type |
|---|---|---|---|
| Projects | name | Name | title |
| Projects | description | Description | rich_text |
| Projects | repositoryUrl | Repository URL | url |
| Projects | status | Status | select |
| Projects | primaryStack | Primary Stack | multi_select |
| Projects | created | Created | created_time |
| Projects | lastUpdated | Last Updated | last_edited_time |
| Subprojects | name | Name | title |
| Subprojects | description | Description | rich_text |
| Subprojects | type | Type | select |
| Subprojects | status | Status | select |
| Subprojects | repositoryPath | Repository Path | rich_text |
| Subprojects | project | Project | relation to Projects |
| Knowledge | name | Name | title |
| Knowledge | type | Type | select |
| Knowledge | verification | Verification | select |
| Knowledge | context | Context / Environment | rich_text |
| Knowledge | files | Files / Paths | rich_text |
| Knowledge | sourceUrl | Source URL | url |
| Knowledge | tags | Tags | multi_select |
| Knowledge | created | Created | created_time |
| Knowledge | lastUpdated | Last Updated | last_edited_time |
| Knowledge | project | Project | relation to Projects |
| Knowledge | subproject | Subproject | relation to Subprojects |

Approved option strings are case- and whitespace-sensitive:

| Property | Exact option set |
|---|---|
| Projects.Status; Subprojects.Status | Active, Paused, Archived |
| Projects.Primary Stack | JavaScript, TypeScript, React, Next.js, Node.js, Python, Django, FastAPI, MongoDB, PostgreSQL, React Native |
| Subprojects.Type | Frontend, Backend, Mobile, API / Service, Infrastructure, Feature, Other |
| Knowledge.Type | Implementation, Technical Decision, Error & Fix, Setup / Runbook, Reference, Learning |
| Knowledge.Verification | Draft, Hypothesis, Verified, Needs Review |
| Knowledge.Tags | architecture, frontend, backend, database, deployment, debugging, auth, performance, testing |

All 24 required properties are validated. Missing, extra, renamed, duplicate or
case-changed options on mapped fields cause drift; option ordering is irrelevant.
Additional unmapped properties are tolerated and never used or modified.

Relations must point to the configured target database and, when the API provides
it, the resolved target data source. A source-only representation is checked
against the uniquely resolved target and mapped back to its configured database;
a database-only representation is unambiguous because exactly one source is
required. A relation with no target is rejected. Production IDs are never
hardcoded into the expected map.

## Resource identity and resolution evidence

Database IDs were established in KAN-3. The matching data-source IDs were
reconfirmed by the user-run KAN-8 PASS result above. Runtime resolution continues
to use validated configuration; none of these IDs are hardcoded in production.

| Database | Database ID | Reconfirmed data-source ID |
|---|---|---|
| Projects | `8ed32b90-b515-468d-9992-e5feb7778c94` | `6cb3353a-16fa-458f-bcad-470097268b40` |
| Subprojects | `e69954b1-208e-47f5-95d1-899d11b64766` | `64e25db4-11f7-4e0c-b3d5-a70a2f1c5696` |
| Knowledge | `8c6dd4fd-d1f2-431a-b5d6-c41dee1c0afd` | `87927b6e-7fe0-44cb-a977-22a62175d2a1` |

## Failure and safety behavior

`SCHEMA_DRIFT` was absent from the KAN-7 catalog and is now a stable shared error.
Its safe issues identify an application-owned database key, an approved property
name where applicable, and a reason such as `MISSING_PROPERTY`, `WRONG_TYPE`,
`OPTIONS_CHANGED`, `RELATION_TARGET`, `WRONG_PARENT`, or `DATA_SOURCE_COUNT`.
Expected source assertion failures and invalid metadata are also reported.
Observed option values, response payloads, credentials, stacks and SDK causes
are not included in public errors.

Authentication, permissions, missing resources, rate limits, timeouts and service
failures map to existing shared error codes, with a safe database key. Check
integration sharing and configured IDs for access failures. Resolve schema drift
through an explicitly approved schema decision; startup never repairs or creates
properties, options, databases, relations or records.

## Commands and evidence boundaries

Use Node `24.22.1` and npm `11.19.1`:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:notion
```

The verification command uses process configuration only and performs six metadata
GETs on success. It prints resolved IDs and property counts, never credentials or
record contents. Exit codes: 0 = verified; 1 = access/API/schema failure;
2 = blocked by invalid/missing process configuration. Startup uses the same
initialization path; there is no production skip-validation flag.

Mocked tests cover all properties, exact option sets, relation targets, invalid and
ambiguous resolution, timeout/API errors, safe drift diagnostics, immutable caches,
and startup failure. An isolated child-process fixture preloads synthetic fetch
responses; its success is not live Notion authentication evidence. Vitest retains
its isolated envDir and does not load the repository `.env`.

Keep the [approved dependencies and nine overrides](dependency-baseline.md).
All SDK imports and SDK-specific types stay in `src/integrations/notion/`.
[Official database metadata endpoint](https://developers.notion.com/reference/retrieve-a-database)
and [data-source metadata endpoint](https://developers.notion.com/reference/retrieve-a-data-source)
describe the API operations used.
