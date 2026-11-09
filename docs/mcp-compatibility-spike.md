# MCP compatibility spike (KAN-5)

Verification snapshot: 9 November 2026 (Asia/Calcutta), Windows x64.

**Local MCP and Antigravity CLI verification passed. Vercel hosted deployment is
NOT YET VERIFIED.** No hosted platform failure was observed; a deployment was not
performed. Production business services have not been implemented.

## Scope and baseline

The disposable spike used the approved [KAN-4 baseline](dependency-baseline.md),
Node `24.22.1`, npm `11.19.1`, and TypeScript `6.0.3`. Strict `npm ci`
passed with lifecycle scripts disabled. No packages were added, and the baseline
lockfile hash remained unchanged.

Only `spike_echo` was registered. It returned a bounded input string and test
marker. No actual DevMemory tools were implemented. KAN-5 did not import the
Notion SDK, call Notion, or read the repository `.env`.

HTTP servers bound to `127.0.0.1` on ephemeral ports. Remote-style transport on
loopback is not evidence of Internet-hosted HTTPS behavior.

## Wire-level results: 18 PASS, 0 FAIL

| Test | Result | Observed behavior |
|---|---|---|
| Local stdio initialization | PASS | Protocol `2025-11-25` negotiated; test server identity returned |
| Local `tools/list` | PASS | Exactly `spike_echo` |
| Local `tools/call` | PASS | Expected echo and marker |
| Stderr-only logging | PASS | Three stdout JSON-RPC frames; zero non-RPC stdout lines; logs on stderr |
| HTTP missing bearer token | PASS | 401; no MCP dispatch |
| HTTP invalid bearer token | PASS | 401; no MCP dispatch |
| HTTP malformed authentication | PASS | 401; no MCP dispatch |
| HTTP initialization | PASS | 200; protocol `2025-11-25`; no session ID |
| HTTP initialized notification | PASS | 202 |
| HTTP `tools/list` | PASS | 200; expected tool; no session ID |
| Valid-token HTTP `tools/call` | PASS | 200; expected echo; fresh server instance; no session ID |
| Concurrent HTTP calls | PASS | Independent server instances and correct results |
| Stateless session GET | PASS | 405 |
| Stateless session DELETE | PASS | 405 |
| Fresh handler without prior initialization | PASS | Tool listing succeeded without stored initialization/session |
| Local Vercel-style fetch contract | PASS | Standard Request/Response entry worked; not deployed |
| Modern discovery | PASS | Protocol `2026-07-28`; JSON; `tools.listChanged: false` |
| Modern subscription rejection | PASS | HTTP 200 with RPC error `-32603`; no stream opened |

The modern raw fixture supplied the required `Mcp-Method` header. Legacy
initialization and modern discovery were separate checks.

## Verified transport behavior

Both entries shared a test-server factory. Local serving used `serveStdio`;
HTTP used `createMcpHandler` and the `toNodeHandler` adapter. A separate
standard `fetch` entry was exercised locally.

Final fixture settings:

```text
Server capability: tools.listChanged = false
HTTP: legacy = "stateless", responseMode = "json", maxSubscriptions = 0
```

HTTP requests received fresh server instances. No `Mcp-Session-Id` was required
or returned; no persistent session store or initialization affinity was needed
for the tested paths.

Legacy initialize/list replies were finite `text/event-stream` responses.
`responseMode: "json"` controls modern response shaping, not legacy framing,
and drops modern mid-call notifications. Listen streams normally remain SSE
regardless; the final fixture explicitly disabled unused subscriptions.

Authentication ran before dispatch with a length check and `timingSafeEqual`.
Rejected requests included a bearer challenge. The token was random, temporary,
and unrelated to user credentials; it was never printed. No credential values
are preserved here. These checks are not a complete production security review.

## Antigravity CLI results

The installed Windows `agy.exe` was invoked against both entries. Server-side
traces confirmed calls with distinct requested echo values, independently of the
client's success message.

| Test | Result | Evidence |
|---|---|---|
| Local stdio connection | PASS | `server/discover` and `tools/list` observed |
| Local tool call | PASS | Unique expected echo observed server-side |
| Streamable HTTP connection | PASS | `server/discover` and `tools/list` observed |
| Authorization header configuration | PASS | Authenticated tool call observed |
| HTTP tool call | PASS | Second unique expected echo observed server-side |
| Static-registry regression | PASS | Both calls worked; no `subscriptions/listen` in final traces |

The final CLI run exited 0, reported SUCCESS, and did not time out. Final methods
on both transports were `server/discover`, `tools/list`, and `tools/call`.
The HTTP trace recorded three authorized requests; two unauthenticated probes
were rejected.

SDK defaults caused Antigravity to open `subscriptions/listen` for tool-list
notifications. Advertising `tools.listChanged: false` prevented this in the
regression test. `maxSubscriptions: 0` also rejected an explicit subscription
without opening a stream. This fits a fixed Phase 1 registry; dynamic tool-list
notifications were not validated.

Temporary workspace configuration supplied `serverUrl` and an `Authorization`
header. Existing global server names were disabled in that workspace; global
configuration was not edited. Session-only permissions allowed the two test
tools and denied command/file-write tools. Live client configuration was removed;
a placeholder-only example remained.

The Antigravity IDE UI was not tested. Results apply to the installed CLI and
loopback endpoints, not every client version or a hosted deployment.

## Vercel: NOT YET VERIFIED

| Check | Status | Evidence or blocker |
|---|---|---|
| Standard fetch entry | PASS locally | Compiled and initialized MCP |
| Stateless request lifecycle | PASS locally | Fresh instances, concurrent calls, no-session operation |
| Hosted build/deployment | NOT YET VERIFIED | No Vercel CLI detected; no spike deployed or deployment URL supplied |
| Hosted auth, HTTPS, cold starts, stream completion | NOT YET VERIFIED | Requires an actual deployed endpoint |
| Hosted timeout/reconnect behavior | NOT YET VERIFIED | No platform duration-boundary or reconnect test |

Official documentation checked during KAN-5 described these constraints:

- Hobby with Fluid compute: 300-second maximum invocation duration, including
  streamed responses. Do not rely on indefinitely open subscriptions.
- Standard limits: 2 GB memory, 250 MB uncompressed function bundle, and 4.5 MB
  request/non-streaming response payloads. SDK/adapter request-body defaults are
  lower, at 4 MiB.
- Export a request handler; do not call `listen()` in the hosted entry. Finish
  work within the invocation and avoid cross-request session state.
- Vercel supports Node 24 but manages patch updates. Exact `24.22.1` and the
  runtime's 14-day maturity age cannot be guaranteed there.
- Hobby permits personal, non-commercial use only; fit for intended use remains
  to be established.

A disposable hosted acceptance test must verify build/dependency tracing, runtime
selection, `/mcp` routing, environment configuration, deployment protection,
HTTPS auth, initialization/discovery, listing, calling, cold starts, finite SSE
completion, timeouts, and reconnects. Local contract and documentation evidence
do not substitute for these tests.

## Production recommendation and remaining work

Keep the approved TypeScript modular monolith, shared services/tool registration,
stdio locally, and stateless Streamable HTTP remotely. Use the Node adapter for
plain Node entry points; the standard Vercel fetch entry can use the web-standard
handler directly. Express was unnecessary for the tested path.

Register exactly the five [approved business tools](architecture-decisions.md),
keep the list static, disable unused subscriptions, and support finite legacy SSE
alongside bounded modern JSON replies. Log to stderr. Authenticate before remote
dispatch over HTTPS; do not log bearer headers or business-tool payloads.

Production origin/host validation, operation deadlines, credential handling, and
deployment configuration still require implementation and review. No local
dependency or transport blocker was found. Hosted acceptance remains open.

## Evidence provenance and cleanup

The source directory was still present when these documents were written:

```text
C:\Users\DESK0034\AppData\Local\Temp\devmemory-kan5-faf034f50751420481c2da0ae3087256
```

Inspected sources: `REPORT.md`, `protocol-results.json`,
`antigravity-results.json`, `src/shared.ts`, `src/http.ts`, and the lockfile.
Supporting fixtures include `tests/protocol.mjs`, `tests/antigravity.mjs`,
`src/stdio.ts`, `src/vercel-entry.ts`, traces, and the default-capability
comparison report. The baseline lockfile hash is in the
[dependency document](dependency-baseline.md).

At spike cleanup, zero spike processes remained. Installed dependencies, runtime,
cache, generated builds, debug files, and live configuration were removed.
Reports, relevant sources, and sanitized evidence remained in temp. No spike
implementation was copied into production folders.

Temp artifacts are machine-local and may expire. This document preserves verified
observations, not a byte-for-byte archive of the spike. No protocol/client tests
were rerun and no dependencies were installed during this documentation update.

## Official references from the verification

- [MCP protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
- [MCP HTTP handler options](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
- [Vercel Node function contract](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel streaming](https://vercel.com/docs/functions/streaming-functions)
- [Vercel Node version policy](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel Hobby restrictions](https://vercel.com/docs/plans/hobby)
