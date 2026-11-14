# Architecture decisions

Status: approved Phase 1 design, with KAN-4/KAN-5 dependency and transport evidence.
Verification snapshot: 9 November 2026 (Asia/Calcutta).

KAN-6/KAN-7 provide the foundation, configuration, errors, and logging. KAN-8 adds
read-only Notion metadata resolution and a startup schema gate; live verification
passed in the user's terminal. KAN-9 implements local stdio, a shared MCP factory,
and read-only project listing; the user reports live acceptance at the KAN-10
handoff. KAN-10 adds digest-authenticated stateless HTTP using that shared factory.
Hosted verification remains KAN-11 work. See
[schema validation](notion-schema-validation.md) and [local MCP](local-mcp.md).
The evidence below records the earlier temporary spike, not a production server.

## Approved decisions and evidence boundaries

| Decision | Intended implementation | Evidence boundary |
|---|---|---|
| Node.js + TypeScript modular monolith | Modular business services and transport adapters in one application | Dependencies and a test-only shared server factory passed |
| Notion as the only source of truth | Official Notion SDK with API `2025-09-03` explicitly selected | SDK compatibility and user-run KAN-8 live metadata/schema validation passed; KAN-5 did not connect to Notion |
| Local MCP over stdio | SDK `serveStdio` entry | Initialization, listing, calling, and stderr logging passed |
| Remote stateless Streamable HTTP | SDK `createMcpHandler`; Node adapter where needed | Loopback HTTP and actual Antigravity CLI calls passed |
| Shared services for both transports | Shared business services and tool registration | KAN-10 stdio/HTTP share KAN-9's factory and project service; local contract tests passed |
| Static bearer authentication remotely | Authenticate before dispatch; HTTPS when hosted | KAN-10 stores current/next SHA-256 digests only and compares two fixed-size buffers with timingSafeEqual; auth failure tests pass |
| Vercel Hobby as intended host | Function request handler without application-level `listen()` | **Hosted deployment is NOT YET VERIFIED** |
| Exactly five business tools | Fixed registry below | KAN-13 adds `get_knowledge_entry` alongside `list_projects` and `get_project_context`; two remain for later tickets. The earlier spike exposed only `spike_echo` |
| No additional persistence infrastructure | No separate database, queue, vector database, or embeddings in Phase 1 | None was needed for the spike |

## Approved business tools

1. `list_projects`
2. `get_project_context`
3. `capture_knowledge`
4. `search_knowledge`
5. `get_knowledge_entry`

KAN-12 adds read-only `get_project_context` to the shared factory. Its business
service and Notion repository reuse both transports, with per-invocation budgets
and explicit scan completeness. See [project context](project-context.md).

`spike_echo` was a disposable compatibility tool, not part of the production set.

KAN-13 adds bounded, read-only Knowledge body retrieval and Markdown conversion.
Its evictable process-local body cache is an optimization over Notion, not another
source of truth or persistence layer. See [knowledge entry](knowledge-entry.md).

## Runtime and dependency policy

Use local Node.js `24.22.1`, proposed Node requirement `>=24.22.1 <25`, and the
exact versions and nine overrides in the [dependency baseline](dependency-baseline.md).
Express is unnecessary for the tested path.

Retain the verified lockfile. Exact direct pins and overrides alone do not freeze
all transitive dependencies. The verification's conservative maturity cutoff was
`2026-10-26T00:00:00+05:30`; no prerelease or younger resolved version was accepted.
Revalidate the entire graph, including optional platform packages, when changing
the baseline.

## Transport and lifecycle decisions supported by the spike

- Create fresh MCP server instances per HTTP request; do not require persistent
  sessions, initialization affinity, or a cross-request session store.
- Advertise the fixed Phase 1 registry with `tools.listChanged: false`.
- The final HTTP fixture used `legacy: "stateless"`, `responseMode: "json"`, and
  `maxSubscriptions: 0`. Both legacy initialization and modern discovery worked.
- Reserve stdout for stdio protocol messages; send structured logs to stderr.
- Support finite legacy SSE responses: the modern JSON setting does not change
  legacy response framing. Avoid indefinitely open notification subscriptions.
- Authenticate before MCP dispatch. Do not log authorization headers, credential
  values, or future business-tool payloads.

Both spike entries used the same test-server factory. Production business services
must follow the approved sharing decision, but were not implemented in the spike.
The official Node adapter can serve a plain Node entry. Vercel's standard
`fetch` contract can consume the web-standard handler directly; that entry only
passed locally.

Production origin/host validation, operation deadlines, credential configuration,
and deployment configuration were open after the spike. KAN-10 now implements
these HTTP boundaries locally; hosted validation is still open. See
[HTTP implementation and evidence](http-mcp.md). The spike remains historical
compatibility evidence rather than hosted deployment evidence.

## Open hosting gate

**Vercel hosted deployment is NOT YET VERIFIED.** No spike was deployed. Local
Request/Response compatibility does not establish hosted build, HTTPS, cold-start,
timeout, reconnect, or stream-completion behavior.

Vercel manages Node minor/patch updates within the selected major, so it cannot
guarantee the exact local patch or the runtime's 14-day maturity rule. Hobby's
personal, non-commercial restriction must fit the intended use. See the
[spike results](mcp-compatibility-spike.md) for documented limits and pending tests.
