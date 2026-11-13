# Local MCP and project listing (KAN-9)

Verification date: 9 November 2026, Windows x64.
Runtime: Node 24.22.1, npm 11.19.1. Approved dependencies and all nine overrides
are unchanged; package.json and package-lock.json retain their baseline contents.
Follow-up client verification: installed Antigravity CLI 1.5.3.

## Acceptance status

At the KAN-10 handoff, **the user reports KAN-9 complete with successful actual
Antigravity invocation using live Notion data**. That is user-reported acceptance,
not a new agent-run live test. The historical agent evidence table below records
the earlier synthetic checks and absent process configuration at that time.
The earlier KAN-8 metadata PASS alone was not used as record-retrieval proof.

| Check | Result and evidence |
|---|---|
| Clean dependency installation | PASS, npm ci --offline using the preserved foundation npm cache; 58 packages |
| Typecheck / lint / build | PASS / PASS / PASS |
| Full deterministic suite | PASS, 248 tests in 9 files |
| Source and freshly compiled stdio | PASS, initialize, tools/list, tools/call, mapping, filters and cursor continuation against synthetic API fixtures |
| Modern discovery | PASS, protocol 2026-07-28; fixed tools.listChanged=false |
| Protocol hygiene | PASS, every stdout line is JSON-RPC; structured logs on stderr; no fixture credential or record content in diagnostics |
| EOF and signal handlers | PASS, EOF exits 0; SIGINT/SIGTERM listeners close and exit 0. Tests emit the Node signal event because Windows kill() forcibly terminates processes |
| Stalled-request signal deadline | PASS, a synthetic upstream handle cannot outlive the two-second shutdown guard; forced deadline exit is 1 |
| Invalid configuration/schema gate | PASS, nonzero exit without protocol output or readiness |
| Actual Notion verification | BLOCKED, NOTION_API and all three NOTION_*_DATABASE_ID variables absent from this process |
| Actual Antigravity returning live projects | BLOCKED, same missing process configuration; see separate synthetic CLI result below |
| Actual Antigravity with synthetic data | PASS after the cursor-pattern fix: CLI 1.5.3 discovered and invoked list_projects through the compiled application and full schema gate; one synthetic project returned |
| Vercel hosted deployment | NOT YET VERIFIED; no HTTP or deployment work in this ticket |

The default npm cache lacked one tarball during the initial offline install.
Repeating clean npm ci with the preserved foundation cache succeeded. No dependency
or lockfile change was needed, and no version or override was relaxed.

## Wiring and lifecycle

Changed-file inventory (new files are marked +; existing files are marked ~):

```text
~ README.md
~ docs/architecture-decisions.md
~ docs/notion-schema-validation.md
+ docs/local-mcp.md
+ scripts/verify-local.mjs
~ src/app.ts
~ src/index.ts
~ src/domain/errors.ts
+ src/domain/projects.ts
~ src/integrations/notion/client.ts
~ src/integrations/notion/README.md
+ src/integrations/notion/projects.ts
+ src/mcp/server.ts
~ src/services/README.md
+ src/services/projects.ts
~ src/transports/README.md
+ src/transports/stdio.ts
~ tests/foundation.test.ts
+ tests/fixtures/mcp.ts
+ tests/fixtures/projects.ts
+ tests/fixtures/projects-preload.mjs
+ tests/mcp.test.ts
+ tests/project-repository.test.ts
+ tests/projects.test.ts
+ tests/stdio.test.ts
```

The initialization path is:

1. Validate process configuration and create the redacted stderr logger.
2. Create one SDK client, then reuse KAN-8 metadata resolution and schema validation.
3. Bind a Notion Projects repository to the validated Projects source/property IDs.
4. Create the project listing service and a transport-independent MCP factory.
5. Start SDK serveStdio only after validation succeeds.

Each factory invocation creates a fresh MCP instance and registers list_projects
exactly once. It advertises a static registry and disables unused subscriptions
in stdio. No HTTP transport, other business tools, or global mutable container
is introduced. Signal/EOF cleanup is idempotent; signal shutdown has a two-second
fallback. Configuration or metadata failures log safe errors and exit nonzero.

The metadata-only reader keeps its previous public methods. The application uses
the extended shared client for both metadata and project queries. SDK imports,
SDK-specific types and raw responses stay inside src/integrations/notion.

## Tool contract

Only list_projects is registered in KAN-9. The four remaining approved tools
belong to later tickets.

| Input | Contract |
|---|---|
| nameContains | Optional trimmed string, 1-200 characters; JavaScript lowercase substring matching |
| status | Optional exact Active, Paused or Archived; no case normalization |
| limit | Integer 1-100, default 50; maximum raw records scanned per call |
| cursor | Optional opaque string, 1-2048 characters without control characters |

Unknown fields are rejected. The service validates with the approved Zod version.
An unknown status produces VALIDATION_ERROR with the allowed values. MCP's input
validator advertises the same precise schema, while returning a fixed validation
message with allowed statuses instead of raw caller keys or values.

Successful structuredContent and the JSON text content contain the same object:

```json
{
  "projects": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "name": "Synthetic example",
      "url": "https://www.notion.so/10000000000040008000000000000001",
      "status": "Active",
      "primaryStack": ["TypeScript"]
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

The example is synthetic. description, repositoryUrl and status are omitted when
unset. The project URL comes from the Notion page URL. Responses contain no SDK
objects, property dictionaries, users, timestamps, or other unnecessary API data.
Service/API failures return isError=true and a safe catalog error with a fresh
per-call correlation ID. SDK input failures use its tool-error envelope with the
fixed validation message. No vendor errors or stacks are returned.

## Filtering and bounded pagination

Status is sent to Notion as a select equals filter using its validated property
ID. Records are sorted by created_time ascending. Each call performs one logical
query with page_size=limit; the shared client's existing bounded timeout/retries
still apply. There is no scan-until-full loop or whole-database retrieval.

The official filter documentation specifies contains but does not promise its
case sensitivity. To guarantee the requested behavior, name matching happens in
the service after retrieving one raw page. nextCursor and hasMore always describe
that raw page. A response may contain zero matches and still have hasMore=true.
**Continue with nextCursor and the same filters/limit until hasMore=false.** This
preserves access to matches beyond sparse pages without discarding unreturned
matches, inventing a cursor store, or fetching unbounded records. Concurrent live
edits are subject to Notion's upstream cursor consistency; no snapshot is claimed.

## Repository mapping and safety

The adapter looks up response properties by their startup-validated property IDs:

| DTO field | Source |
|---|---|
| id / url | Notion page id / url |
| name | Name title plain_text fragments joined |
| description | Description rich_text plain_text fragments joined |
| repositoryUrl | Repository URL url |
| status | Status select name, checked against approved options |
| primaryStack | Primary Stack multi_select names, checked against approved options |

Required fields, property types, source parent, enum options and pagination
consistency are validated before returning application-owned immutable objects.
Absent/empty optional values are omitted. Invalid records fail safely rather than
silently being dropped. Existing safe API error translation is reused.

The fetch allowlist permits official metadata GETs and POST /query only for the
bound Projects source. POST here is a read operation. Record writes, schema
changes, other endpoints and redirects remain denied. No Notion writes were
performed during KAN-9, and the repository .env was never read or modified.

## Antigravity configuration

The installed executable was found at:

```text
C:\Users\DESK0034\AppData\Local\agy\bin\agy.exe
```

Its --version reported 1.5.3; --help, mcp --help and mcp add --help were checked.
The official docs describe both workspace .agents/mcp_config.json and global
~/.gemini/config/mcp_config.json. The workspace-only diagnostic was not recognized
by mcp list and did not launch the test entry in print mode. Do not assume that
documented workspace support proves that a particular installed session loaded it.

The existing global configuration was inspected without exposing credential
values: it contains only an unrelated server, with no DevMemory entry. A disposable
configuration generated by the actual mcp add command used command, args and
disabled, confirming the basic stdio entry shape. No actual global configuration
was changed.

The following credential-free entry uses the actual built output and verified
local Node runtime (a temporary runtime path that must be replaced if cleaned up).
Merge it into the effective client configuration; preserve existing entries.
Verify both mcp list recognition and an actual call, rather than relying on the
filename alone. The diagnostic's isolated profile and Windows migration caveat
are recorded below.

```json
{
  "mcpServers": {
    "devmemory": {
      "command": "C:\\Users\\DESK0034\\AppData\\Local\\Temp\\devmemory-foundation-runtime-b5c41435be544575a210b5d7758cb71f\\node-v24.22.1-win-x64\\node.exe",
      "args": ["D:\\devmemory\\dist\\index.js"],
      "cwd": "D:\\devmemory",
      "enabledTools": ["list_projects"],
      "tools": { "list_projects": { "eager": true } },
      "timeoutSeconds": 45
    }
  }
}
```

Do not put tokens in that JSON. Launch Antigravity from the same PowerShell session that securely
supplies NOTION_API, the three database IDs, and MCP_TRANSPORT=stdio. A desktop
process already running without those variables must be restarted from that
environment. Do not assume a new terminal inherits another terminal's variables.

The successful CLI probe used a disposable isolated configuration profile,
allowed only list_projects, denied command/file-write tools, and supplied
synthetic Notion responses through a temporary bootstrap. It then dynamically
imported the actual dist/index.js: the real startup gate, client, repository,
service, factory and stdio lifecycle all ran. All four synthetic environment
variables reached the child, Node reported 24.22.1, and cwd was D:\devmemory.
This demonstrates environment inheritance with synthetic values, not availability
of real credentials. Only event names, response keys, tool names and counts were
preserved in the trace; no record contents or tokens were printed. Temporary
configuration and raw logs were removed. This does not establish live Notion access.

## Exact remaining live checks

In the existing securely configured PowerShell session, with Node 24.22.1 first
on PATH and npm 11.19.1:

```powershell
Set-Location D:\devmemory
$env:MCP_TRANSPORT = "stdio"
npm run build
node scripts/verify-local.mjs
```

The live verifier starts dist/index.js without test preloads and exercises
initialize/list/call, DTO shape, mixed-case name matching, exact status and a
second page when available. It prints statuses/counts only. No token, project
contents or cursor is printed. Exit 0 means all checks passed; exit 2 means
missing configuration or insufficient records; exit 1 means a failed check.
It never reads .env or writes Notion. Missing credentials currently cause a
BLOCKED result before any API request.

Then use the documented Antigravity entry to call list_projects with limit=1.
Record client tool discovery and a completed server-side call returning an actual
project. Exercise name/status filters and cursor continuation where data permits.
Do not create records just to satisfy the probe. If fewer than two projects exist,
report live pagination as unverified due to insufficient records.

After closing these KAN-9 acceptance gaps, the suggested next ticket is KAN-10,
the remote stateless Streamable HTTP transport reusing this factory/service.
Hosted Vercel acceptance remains a separate gate.

## Official references checked

- [MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/); installed 2.4.0 declarations and transport implementation were also inspected.
- [Notion query endpoint](https://developers.notion.com/reference/query-a-data-source).
- [Notion filter semantics](https://developers.notion.com/reference/filter-data-source-entries); runtime explicitly remains on API 2025-09-03.
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp).

## Final CLI evidence

The earlier probes reported the tool unavailable, sometimes with a zero CLI exit
and SUCCESS envelope. The follow-up isolated configuration loading from toolbox
schema validation and found two distinct issues:

1. The workspace-only definition was not loaded in the observed session.
   The supported compatibility flag --gemini_dir=<absolute-directory> made
   mcp list recognize a disposable <profile>/config/mcp_config.json entry. Print mode on
   this Windows installation also exhibited a failed legacy-config symlink
   migration. The successful fixture supplied identical credential-free entries
   at <profile>/config/mcp_config.json and
   <profile>/antigravity-cli/mcp_config.json. No user auth files were inspected
   or copied, no symlink privileges were changed, and no global files were edited.
   This is evidence for this isolated Windows profile, not a recommendation to
   duplicate live global configuration blindly.
2. Once the shared factory was loaded, CLI 1.5.3 exited 3 while building its
   toolbox: properties/cursor/pattern contained an invalid escape sequence for
   its Go regex validator. The original advertised pattern used Unicode escapes
   (\\u0000, \\u001f, \\u007f), which are valid JavaScript regex syntax but were
   rejected by that client. KAN-5 spike_echo had only a bounded string input and
   therefore did not exercise this cursor pattern.

The minimal code fix replaces those Unicode escapes with equivalent hex escapes
(\\x00, \\x1f, \\x7f). No allowed/rejected cursor characters, length constraints,
business behavior, dependencies, schema or architecture changed. A contract
regression assertion verifies the advertised pattern and every excluded ASCII
control character. The actual CLI accepted the replacement.

Before/after evidence from the same synchronous shared-factory fixture:

| Check | Original pattern | Fixed pattern |
|---|---|---|
| CLI recognizes configured server | Yes | Yes |
| server/discover and tools/list | Observed | Observed |
| Toolbox schema validation | FAIL, invalid cursor regex escape | PASS |
| tools/call and completed service event | Not observed | Observed, count 1 |
| CLI exit | 3 | 0 |

The subsequent compiled-application probe also passed with synthetic API data:

```json
{
  "client": "Antigravity CLI 1.5.3",
  "node": "24.22.1",
  "cwd": "D:\\devmemory",
  "configurationRecognized": true,
  "schemaMetadataReads": 6,
  "schemaGate": "PASS",
  "discovery": "PASS",
  "tools": ["list_projects"],
  "projectQueries": 1,
  "completedCalls": 1,
  "returnedProjectCount": 1,
  "stdioClosed": true,
  "clientExit": 0,
  "timedOut": false,
  "data": "synthetic"
}
```

The signed-in-user/plugin-reloading warning remained present in this successful
run. It was not the cause of the reproduced parameter-schema failure; no sign-in
requirement or credentials workaround is inferred from it.

Only src/services/projects.ts (equivalent cursor regex), tests/mcp.test.ts
(regression assertions), and this document changed in the troubleshooting batch.
Build, typecheck, lint and all 248 tests passed afterward. Independent raw-protocol
tests cover legacy initialize/list/call and modern discover/list/call.

At the end of that troubleshooting run, the remaining acceptance blocker was real process configuration: NOTION_API,
NOTION_PROJECTS_DATABASE_ID, NOTION_SUBPROJECTS_DATABASE_ID and
NOTION_KNOWLEDGE_DATABASE_ID are all absent in the agent-run verification process.
The live verifier returned BLOCKED (exit 2) before any Notion API request.
Run it and the effective Antigravity entry from a securely configured session;
only a call returning actual Notion projects closes live acceptance. The subsequent
KAN-10 request reports that this live check has now passed. No missing credentials
were reconstructed or read from .env during either implementation batch.
