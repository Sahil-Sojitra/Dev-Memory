# Stateless HTTP and bearer authentication (KAN-10)

Implementation verification: 9 November 2026, Node 24.22.1 / npm 11.19.1.
**Hosted Vercel deployment is NOT YET VERIFIED.** No deployment, project linking,
production credential generation, or live Notion modification was performed.

The KAN-10 request reports that KAN-9 has passed actual Antigravity invocation
with live Notion data. That is user-reported acceptance, separate from the prior
agent-run synthetic evidence preserved in [local MCP](local-mcp.md).

## Routes, build and runtime

There is one framework-free Node function, api/index.ts, exporting a default
object with fetch(Request): Promise<Response>. vercel.json rewrites /api/mcp,
/api/health and /api/ready to that function at /api. Related routes share a warm
application cache, rather than deploying separate functions with separate caches.
Routing/rewrites follow the official Node function and project configuration docs
linked below. The function does not open sockets or start a persistent server.

The function imports src/transports/http.ts, which uses the existing
initializeApplication and shared createMcpServer factory. No tool registration or
business logic is duplicated. Only list_projects is exposed. Notion SDK types
and imports stay in the integration layer. The local stdio entry and MCP factory
were not modified for KAN-10.

Build outputs:

- dist/index.js remains the compiled stdio entry.
- dist/vercel/api/index.js is the separately compiled function contract fixture,
  with relative imports resolving to dist/vercel/src. Tests invoke this actual
  compiled entry, including the SDK-backed query adapter.
- Vercel discovers root api/index.ts and compiles/traces its TypeScript imports;
  dist/vercel is for local verification, not a claim of generated Vercel Build
  Output API artifacts. No framework or frontend output directory is configured.

The configured install command is npm ci, retaining the existing strict .npmrc.
The build command compiles both targets. package.json retains Node >=24.22.1 <25,
npm 11.19.1, all exact dependencies and nine overrides. package-lock.json remains
byte-for-byte unchanged. Vercel chooses/manages the Node major and patch according
to its runtime policy; it cannot guarantee the exact local patch. Select and
verify Node 24 and the actual build-tool versions during KAN-11.

## Authentication configuration

Required HTTP configuration, in addition to the existing Notion variables:

| Variable | Meaning |
|---|---|
| MCP_TRANSPORT | Must be http for the function; stdio remains the local default |
| MCP_BEARER_TOKEN_SHA256 | Current token's SHA-256 digest: exactly 64 hex characters |
| MCP_BEARER_TOKEN_NEXT_SHA256 | Optional next digest: omit when unused; empty strings are invalid |
| MCP_PUBLIC_URL | Public HTTPS endpoint URL, normally https://your-host/api/mcp |
| MCP_ALLOWED_ORIGINS | Optional comma-separated explicit HTTPS origins; default empty |

Hex digests are normalized and decoded into 32-byte buffers. Configuration errors
retain field names only, not values or raw Zod input. HTTP mode explicitly rejects
the previous plaintext MCP_BEARER_TOKEN variable. Remove it from server environment
configuration when migrating; do not change the repository .env as part of this
ticket. The digest of the Notion credential is also rejected in either bearer slot.
Local stdio ignores unrelated HTTP settings and requires no bearer credential.

Never commit either a token or its digest. .env.example contains empty placeholders
only. No code loads the repository .env automatically.

## Verification algorithm and rotation

Every MCP request, including unsupported methods, requires one Authorization
header with a Bearer token. The scheme is case-insensitive and followed by one
space. Tokens must be 32-512 ASCII bearer-token characters (RFC-compatible
alphabet); generated 32-byte base64url tokens satisfy this policy. Header values
longer than 1024 characters, duplicate/combined values, commas, empty values,
quoted tokens and unsupported schemes fail authentication.

The verifier hashes the presented token with SHA-256, then invokes Node's
crypto.timingSafeEqual twice on 32-byte buffers. Both comparisons run for current,
next, wrong and malformed credentials; there is no short-circuit between slots.
Without a next digest, a duplicate current-digest slot preserves two comparisons.
Ordinary string equality is not used for credential verification. Parsing/hashing
work can vary with public input length; this is not a claim that whole HTTP
requests execute in constant time.

All authentication failures have the same 401 JSON body, Bearer challenge and
no-store policy. No supplied value is echoed. Invalid/missing server configuration
fails closed with 503; there is no unauthenticated fallback. Authentication occurs
before body reads, JSON parsing, schema initialization or MCP dispatch.

For rotation:

1. Generate a new independent token locally and calculate its digest.
2. Add its digest as NEXT, retaining CURRENT. Both credentials work.
3. Move clients to the new token using protected client secret configuration.
4. Replace CURRENT with the new digest and remove NEXT, retiring the old token.

The function validates configured digests per request. Vercel environment changes
normally require a new deployment; do not assume already-running instances receive
dashboard edits immediately. The application metadata/client cache is independent
of bearer rotation. Notion configuration changes require a fresh application
lifecycle/deployment, rather than hot mutation of cached services.

Only digests are retained as server authentication configuration. Plaintext appears
transiently in the incoming Request and request-scoped error redaction, is never
cached across requests, and is never placed in files, logs, Notion or server
environment configuration. Authorization, cookies and proxy authorization are
removed before handing the request to the SDK. SDK error frames are redacted using
the existing redactor, including a reproduced unknown-tool-name reflection case.
Successful project data and SDK protocol framing remain unchanged. Application
diagnostics use Pino with generated correlation IDs and safe catalog errors.
The installed SDK emits a fixed responseMode=json warning to stderr; it contains
no request data. No global console monkey-patching is used to suppress that warning.

## Stateless request lifecycle

The installed server SDK 2.4.0 declarations and implementation, and the KAN-5
fixture, were checked before adopting:

```text
legacy: "stateless"
responseMode: "json"
maxSubscriptions: 0
maxRequestBodySize: 65536
keepAliveMs: 0
```

Each authenticated exchange gets a fresh SDK handler and MCP server context,
using the shared factory. No session ID is required or returned. Requests can
initialize/list/call independently and concurrently without initialization affinity
or a session store. Only validated application services and schema metadata are
cached per warm function; they are not client sessions. The tool registry remains
static with tools.listChanged=false.

Legacy replies remain finite text/event-stream responses; modern replies use
application/json. Modern raw clients must send the SDK-required protocol, method
and name headers, including Mcp-Name for named calls. The SDK owns JSON parsing,
validation, protocol errors and dispatch. Notifications receive its normal 202
response. Subscription attempts are rejected without opening an indefinite stream.

The adapter buffers bounded finite SDK output, closes the handler and all created
servers, then returns a Web Response. This preserves SSE framing while deliberately
not providing live notification/progress streaming. Cleanup also runs on errors,
timeouts and client cancellation. Hop-by-hop and session headers are not returned.
Concurrent tests verify distinct instances and closure, rather than relying only
on response headers as evidence of statelessness.

## Security boundaries and limitations

- Only POST is supported for /api/mcp. Authenticated GET, DELETE, OPTIONS and other
  methods return 405 with Allow: POST; no session GET/DELETE endpoints exist.
- Before SDK parsing, the byte reader enforces 64 KiB even if Content-Length is
  absent or lies. Oversized declared or streamed bodies return 413. Non-JSON and
  compressed bodies return 415. JSON syntax/protocol errors remain SDK-owned.
- The incoming URL must use HTTPS and its host must equal the configured public
  URL's host. A supplied Host header must agree, case-insensitively. No wildcard
  hosts, inferred preview aliases, or X-Forwarded-Host/Forwarded trust is introduced.
  Configure the exact public host for each deployment; platform host rewriting
  still needs hosted verification.
- Missing Origin is accepted for non-browser clients such as Antigravity. A present
  Origin must exactly match the explicit allowlist; null and unlisted origins are
  rejected. No permissive CORS headers or preflight access are added. An allowlisted
  origin does not itself enable cross-origin browser access.
- Query strings are rejected on protected endpoints. Credentials must not be put
  in URLs. Logs do not include headers, bodies, URLs, record contents or raw errors.
- Responses use no-store and nosniff. Successful requests receive a generated
  correlation header; authentication failures retain a fixed response shape.
- The request deadline is 45 seconds; oversized output is bounded at 4 MiB and
  returns a safe 503. This is below Vercel's documented payload ceiling. The
  function is configured for a 60-second maximum duration, pending hosted checks.
- Notion uses its existing 10-second request timeout and bounded retries. An
  individual caller's timeout does not cancel shared application initialization
  being awaited by other callers; upstream SDK work has its own bounds. Lifecycle
  behavior at the hosted duration/freeze boundary remains a KAN-11 check.
- Web Headers exposes combined duplicates, which are rejected. If an upstream
  proxy silently discards duplicate Authorization fields, the function cannot
  reconstruct discarded wire headers. Platform header behavior needs verification.
- There is no distributed rate limiter or added queue/database. Valid-token abuse
  can still consume function/Notion quota. Function limits, finite bodies and
  authentication are not a substitute for credential security or platform controls.

## Health and readiness

GET/HEAD /api/health is public liveness only. It returns status ok, reads no
configuration, makes no Notion request and exposes no internal environment data.

GET/HEAD /api/ready requires valid HTTP configuration and bearer authentication,
then confirms the shared initialization/schema gate. Success returns status ready;
failure returns a safe 503 status not_ready. A warm successful initialization is
reused across readiness and MCP calls. Concurrent cold requests share one promise.
Failed initialization has a 30-second per-instance retry cooldown, preventing a
failing monitor from triggering expensive Notion metadata calls on every poll.

Readiness confirms cached startup prerequisites, not continuous live Notion
availability. Health does not imply readiness. Neither endpoint returns tokens,
IDs, schemas, configuration fields or SDK causes.

## Local token generation (manual, not executed by the agent)

Run in a private PowerShell session. These examples work without installing a
package and do not print or write a token/digest. Transfer the values directly
into protected client/server secret configuration using your chosen secure tooling.
Do not add real credentials to this document, Git, ChatGPT, Jira, transcripts or
shared terminal output. Do not reuse the Notion API credential.

```powershell
$devmemoryRandomBytes = New-Object byte[] 32
$devmemoryRng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $devmemoryRng.GetBytes($devmemoryRandomBytes) }
finally { $devmemoryRng.Dispose() }

$devmemoryBearerToken = [Convert]::ToBase64String($devmemoryRandomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$devmemoryHasher = [Security.Cryptography.SHA256]::Create()
try {
    $devmemoryDigestBytes = $devmemoryHasher.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($devmemoryBearerToken)
    )
    $devmemoryBearerDigest = -join ($devmemoryDigestBytes | ForEach-Object {
        $_.ToString('x2')
    })
}
finally { $devmemoryHasher.Dispose() }

# SERVER: only the digest, configured outside the repository.
$env:MCP_BEARER_TOKEN_SHA256 = $devmemoryBearerDigest
# CLIENT: transfer $devmemoryBearerToken to protected client configuration.
# Do not assume a client's environment-interpolation syntax without checking it.
# Example transient request header (not a server setting or a file):
$devmemoryClientHeaders = @{ Authorization = "Bearer $devmemoryBearerToken" }
```

For NEXT, repeat generation with a fresh independent random token and configure
its digest as MCP_BEARER_TOKEN_NEXT_SHA256. Do not put the current token into that
variable. After securely transferring secrets, clear temporary PowerShell
variables/arrays and close the private session when finished. Managed strings
cannot be guaranteed to be zeroed; no such memory-erasure guarantee is claimed.

## Local verification and KAN-11 gate

| Check | Local result |
|---|---|
| Typecheck / lint / both build targets | PASS / PASS / PASS |
| Full deterministic suite | 325 tests passed in 12 files |
| Digest authentication | 26 bearer tests passed, including two-slot comparisons and rotation |
| HTTP security / protocol / lifecycle | 46 tests passed |
| Compiled Vercel entry | 2 tests passed; six synthetic metadata reads and two parallel project queries |
| Existing local MCP and stdio | Passed in the full suite; factory and stdio source unchanged |
| Hosted Vercel build/deployment | NOT YET VERIFIED; KAN-11 |

Run npm run check with the approved Node/npm versions. Tests include digest format,
both rotation slots, uniform challenges, fixed-size two-slot comparisons, duplicate
headers, authentication before body reads, host/origin checks, streamed size caps,
timeouts, cleanup, cached readiness, SDK error redaction, legacy/modern MCP calls,
concurrency and existing stdio regressions.

The compiled-entry subprocess test uses synthetic process configuration and a
no-network API preload. It invokes the actual api default fetch export, checks
health and rejected authentication without Notion calls, warms readiness once,
initializes MCP, discovers list_projects, and performs concurrent SDK-backed
project queries. Its success is local contract evidence, not hosted deployment or
new live Notion authentication evidence. No Vercel CLI was installed or invoked.

KAN-11 must verify a real Vercel build and function tracing, Node/npm selection,
original URL/Host behavior through rewrites, protected environment injection,
HTTPS and deployment-protection behavior, bearer rotation, live Notion access,
Antigravity HTTP calls, finite SSE completion, cold starts, payload ceilings,
timeouts/cancellation and concurrent requests. No hosted PASS is claimed here.

## Changed modules

- api/index.ts; src/transports/http.ts and bearer.ts: function entry, security,
  request lifecycle and digest verification.
- src/config/environment.ts; src/domain/errors.ts; src/observability/redaction.ts:
  digest validation, safe HTTP errors and digest-key redaction.
- vercel.json; tsconfig.vercel.json; tsconfig.json; package.json build script;
  scripts/lint.mjs: routing, both build targets, API typechecking and static checks.
- .env.example; README.md; architecture/local MCP documentation and transport
  boundary notes: configuration migration, scope and evidence provenance.
- tests/bearer.test.ts; http.test.ts; vercel.test.ts; fixtures/vercel-probe.mjs;
  fixtures/environment.ts; config.test.ts: deterministic security/protocol coverage.

No new dependency, tool, Notion schema change, persistence layer, HTTP listener,
production token or deployment was introduced. The repository .env was not read
or modified; nothing was staged, committed or pushed.

## Official references checked

- [Vercel Node runtime, Web fetch export and TypeScript conventions](https://vercel.com/docs/functions/runtimes/node-js).
- [Vercel single-function routing guidance](https://vercel.com/docs/functions/quickstart).
- [vercel.json functions and rewrites](https://vercel.com/docs/project-configuration/vercel-json).
- [Vercel function limitations](https://vercel.com/docs/functions/limitations).
- [MCP createMcpHandler](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html); installed 2.4.0 declarations/source and KAN-5 fixtures were also inspected.
