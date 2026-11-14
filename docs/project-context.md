# Project context (KAN-12)

`get_project_context` is a read-only tool shared by the existing stdio and
stateless HTTP transports. It uses the validated Projects, Subprojects and
Knowledge schemas and the application's existing Notion client. It performs no
record writes, schema repairs, block-content retrieval or semantic search.

## Inputs and scope

| Input | Contract |
|---|---|
| `projectId` | Required canonical UUID; normalized to lowercase |
| `subprojectId` | Optional UUID; must belong to the selected project |
| `recentLimit` | Integer 1-25, default 10; applied independently to each list |

Unknown arguments are rejected without echoing caller keys or values. A missing,
archived or wrong-source project returns `NOT_FOUND`. A missing or unrelated
subproject returns `INVALID_RELATION`. Access/transport failures during relation
verification remain dependency errors; they are not treated as non-membership.
Truncated inline Project relations are paginated through the read-only property
endpoint before membership is decided, using the same request budget.

The optional subproject scopes every Knowledge query using both Project and
Subproject relation filters. It does not restrict the associated subproject list.
Only records explicitly related to the selected Project are counted; relations
are not inferred through a Subproject alone.

## Response

- `project`: existing Project DTO, preserving the `list_projects` field contract.
- `subprojectId`: included when a subproject scope was requested.
- `subprojects`: mapped name, URL, optional description/type/status/repository
  path and Project relation IDs.
- `knowledgeCounts`: `total`, `byType` and `byVerification`. Every approved option
  has a zero-initialized bucket; unset selects use the response label `Unspecified`.
  That label is not a new Notion option or property.
- `recentKnowledge`: matching Knowledge entries sorted by Last Updated descending.
- `setupRunbooks`: independently queried entries whose Type is `Setup / Runbook`.
- `needsReview`: independently queried entries whose Verification is `Needs Review`.
- `scan`: a separate completeness descriptor for subprojects, counts and each list.
- `requestBudget`: maximum requests, used outbound attempts and overall deadline duration.

Knowledge DTOs include ID, name, URL, Last Updated, tags, optional Type,
Verification, Context / Environment, Files / Paths and Source URL. They expose
no SDK response objects. An entry may appear in all three lists. Each list gets
its own `recentLimit`; they do not share or subtract from a combined item limit.
The repository requests newest Last Updated first, and the service sorts each
returned list again, using ID as a deterministic local tie-breaker.

## Bounds and incomplete results

There was no shared per-tool budget before KAN-12. This ticket adds one budget
for each context invocation, propagated through the integration layer using
async-local request state. Concurrent invocations do not share counters.

- Maximum 20 outbound Notion attempts, including SDK retries and relation paging.
- A 30-second overall deadline covers the service operation, SDK requests,
  response-body reads, retry waits and relation pagination. A monotonic-clock
  check also rejects late completions if event-loop work delayed the timer.
- Expiry aborts the context's fetch signals and cancels active response readers.
  Deadline races reject even non-cooperative fetch/text adapters; late results
  cannot be published as successes or advance service scans.
- SDK retry sleeps have no cancellation API. An existing sleep can finish in the
  background (at most the configured 500 ms delay), but cannot start a new fetch
  after expiry. No deadline controller or timer is shared between tool budgets.
- The service disposes its deadline timer and listeners on success or failure.
  The shared Notion SDK client, its existing per-request timeout/retry settings,
  and the HTTP transport deadline remain unchanged.
- Subproject and classification scans use pages of at most 100, with separate
  500-record caps. Each displayed knowledge list queries one page of at most 25.
- Startup schema metadata requests occur before the tool and are outside its budget.
- Project lookup and optional subproject validation must succeed. If the budget
  prevents them, the tool returns `REQUEST_BUDGET_EXCEEDED` rather than claiming
  the IDs or relationship are valid.
- After those prerequisites, attempt-cap exhaustion before the deadline returns
  the available partial result with incomplete sections explicitly marked.
- Overall deadline expiry always returns `REQUEST_BUDGET_EXCEEDED`, not a late
  successful or partial context. Earlier SDK timeouts retain `TIMEOUT` semantics.

Each `scan` descriptor contains `scanned`, `complete`, `truncated` and `reason`:

| Reason | Meaning |
|---|---|
| `null` | The query/scan exhausted its matching records |
| `result_limit` | The list has more matches than its independent result page |
| `scan_limit` | The scan reached 500 records while Notion reported more |
| `request_budget` | The shared attempt cap prevented completing the section before the deadline |

When counts are incomplete, they are lower bounds for successfully scanned unique
records. Zero with `complete: false` is not proof of an empty dataset. There is
no unbounded scan-until-complete fallback. Repeated cursors and duplicate scanned
record IDs fail safely instead of looping or inflating counts. This response
does not provide continuation cursors for capped aggregate scans.

Separate queries are not a transactional snapshot. Concurrent Notion edits can
make list contents and counts differ. The HTTP response-size ceiling still
applies if unusually large rich-text fields exceed the existing bounded payload.

## Verification

Tests use synthetic Notion responses, not live credentials. Coverage includes
input bounds, missing/archived/wrong-source identities, invalid relationships,
paginated relations, filters by validated property IDs, independent overlapping
lists, null classification buckets, pagination, exact/incomplete scan caps,
cursor/record regressions, shared retry budgets and concurrent budget isolation.
MCP adapter tests cover discovery, schemas, safe errors and text/structured parity.
Source and compiled stdio tests invoke the new tool and retain protocol hygiene.
Deterministic deadline tests cover stalled fetches and body reads, SDK retries,
relation pagination, successful completion, late resolution/rejection, resource
cleanup and concurrent isolation. Cancellation is best effort for custom adapters
that ignore AbortSignal or expose only text(); their results still cannot escape
the deadline. JavaScript cannot preempt synchronous CPU work, so the final clock
check rejects late results after that work yields.

Run `npm run check` with the approved runtime. No new dependencies, environment
variables, deployment settings or Notion properties are required. Production
invocation must be verified after a separately authorized deployment.
