# Bounded Knowledge keyword search (KAN-15)

`search_knowledge` is the fifth tool in the shared MCP factory. Both transports
use the same service and Notion repository. It reads existing Knowledge metadata
and bodies; it does not write, change schemas, create an index or use embeddings.

## Input

```ts
{
  query: string;                 // Required, 1-200 characters before normalization.
  projectId?: string;            // Notion project page UUID.
  subprojectId?: string;         // Notion subproject page UUID.
  type?: KnowledgeType[];        // Exact existing Type options.
  verification?: KnowledgeVerification[]; // All four existing statuses.
  tags?: KnowledgeTag[];         // Exact existing Tags options.
  depth?: "metadata" | "auto";  // Default auto.
  limit?: number;                // Integer 1-25; default 10.
}
```

Unknown properties/options, empty filter arrays, duplicate filter values, invalid
UUIDs, blank/punctuation-only queries and invalid limits are rejected before I/O.
The shared MCP input bound remains 16 elements. Search also enforces this bound
on normalized object keys (including default depth/limit) plus array members.
Queries have at most 32 distinct tokens. Option spelling/case must match
[the verified schema](../src/domain/schema-map.ts); keywords are case insensitive.

A supplied project is retrieved and validated. A supplied subproject is retrieved
and, when a project is supplied too, must belong to it (`INVALID_RELATION` on
mismatch). Subproject-only filtering is allowed and validates that page exists.

Examples:

```json
{ "query": "node startup", "depth": "metadata", "limit": 5 }
```

```json
{ "query": "authentication timeout", "type": ["Error & Fix", "Reference"], "verification": ["Verified"], "tags": ["auth"], "depth": "auto", "limit": 10 }
```

## Candidate retrieval and depth

The repository uses `dataSources.query` in the approved SDK with the existing
API version `2025-09-03`. Filters use validated property IDs: relation `contains`
for project/subproject, select `equals` OR groups within each Type/Verification
array, and a separate multi-select `contains` condition for every tag. These
groups are combined with AND. Keywords are matched in the application so body-only
matches are not excluded by an upstream title/context filter.

These operations follow the official [data-source query](https://developers.notion.com/reference/query-a-data-source)
and [filter semantics](https://developers.notion.com/reference/filter-data-source-entries).
The installed SDK's query types and fixture HTTP requests are checked locally;
this implementation has not been verified against live Notion.

| Bound | Value |
|---|---|
| Candidate page size | 50 |
| Candidate pages / unique entries | 4 / 200 |
| Candidate selection | Notion last-edited descending, before keyword ranking |
| Body selection in auto | Up to 25 candidates, newest Last Updated then page ID |
| Body depth / blocks / extracted characters | Existing limits: 5 / 500 / 100,000 per body |
| Snippet | At most 240 UTF-16 code units |
| Search budget / overall deadline | 40 outbound attempts / 30 seconds |

`metadata` never invokes the Knowledge body service, block retrieval or Markdown
conversion. Every result reports `bodyScanned: false` and body counts are zero.

`auto` examines its bounded body selection even when metadata already fills
`limit`. It refreshes each selected page through the existing Knowledge service,
then combines metadata and converted body scoring before applying the final
limit. Changed filter membership and deleted/wrong-source pages are removed and
reported. Existing complete-body cache hits still require fresh page metadata.
Inline truncated metadata relations are explicitly reported; metadata mode does
not secretly paginate relations or read bodies.

## Matching and ranking

Normalize keywords and text with Unicode NFKC, lowercase and collapsed whitespace.
Tokenize runs of Unicode letters, numbers and underscore. Punctuation and path/URL
separators split tokens. Match whole tokens with OR semantics; there is no fuzzy
matching, stemming, substring expansion or semantic interpretation. For example,
`deploy` does not match `deployment`. A phrase is a contiguous sequence of at
least two query tokens; punctuation separators are equivalent to whitespace.

| Field | Points per distinct matching query token |
|---|---:|
| Title | 80 |
| Context / Environment | 30 |
| Files / Paths | 35 |
| Source URL | 10 |
| Tags | 25 |
| Type | 15 |
| Verification | 10 |
| Project relation UUID tokens | 5 |
| Subproject relation UUID tokens | 5 |
| Converted body | 45 |

A matching phrase adds the field weight once. An exact normalized full title
adds 1,000 points. Every additional matching field adds 10 points. Repetition
does not multiply token or phrase points. Scores descend, then Last Updated
descends, then page UUID ascends using ordinal comparison. Fields are evaluated
in a fixed order, independent of object enumeration.

For `deploy node`, an exact title scores 1,240; title `Deploy worker` plus matching
context and file path scores 295; partial title `How to deploy node safely`
scores 240. A body-only phrase scores 135 and outranks a context-only phrase (90).
Snippets prefer the strongest matching field, include surrounding matching text,
collapse whitespace and are represented as JSON strings, never rendered as HTML.

## Response and completeness

`results` contains up to `limit` entries with `id`, `title`, `url`, available Type
and Verification, tags, project/subproject UUIDs, relation completeness,
`lastUpdated`, bounded `snippet`, `matchedIn`, `score`, per-field `scoreBreakdown`,
`bodyScanned`, `bodyTruncated` and `bodyTruncationReasons`.

`diagnostics` reports the normalized query/depth, retrieved/evaluated metadata
candidates, pages, selected/scanned bodies, body cache hits, matches evaluated,
results returned, current `requestCount`, `evaluationRequestCount`, budget/deadline,
candidate/body completeness, unselected/unscanned/truncated bodies, truncated
relations, changed candidates and sanitized body failure code counts. These are
counts of evaluated work, not database-wide totals. Counts exclude startup schema
initialization; that is the existing application lifecycle before tool execution.

`truncated` is true whenever any of these reasons apply:

| Reason | Meaning |
|---|---|
| `candidate_limit` | More candidates existed after 200 entries |
| `pagination_limit` | More candidate pages existed after four pages |
| `body_candidate_limit` | Some retrieved candidates were outside the 25-body selection |
| `request_budget` | An outbound attempt limit prevented completing work |
| `body_truncated` | At least one body had incomplete extracted content |
| `body_read_failed` | A selected body read failed with a safe transient error |
| `relation_limit` | Some returned metadata relations were incomplete |
| `candidate_changed` | A selected candidate disappeared, moved or stopped satisfying filters |
| `result_limit` | More positive-score evaluated matches existed than requested |
| `data_changed` | Capture invalidated the cache while this search was running |

Per-body reasons preserve existing `depth_limit`, `block_limit`, `content_limit`,
`unsupported_block`, `request_budget` and relation conventions. `bodyEvaluationComplete`
in metadata mode means the requested metadata-only work needs no body evaluation;
in auto it requires all retrieved candidates to have complete scanned bodies.
Inspect it alongside `candidateScanComplete` and top-level reasons. A zero-result
bounded search is not evidence that the whole database has no match.

Transient individual body failures retain valid metadata matches with
`bodyScanned: false`. Authentication, permission and schema failures remain errors.
Attempt exhaustion can return described partial results. Overall deadline expiry
always fails safely rather than returning a late successful partial result.

## Shared attempts, cancellation and cache

Search owns one 40-attempt budget. Scope checks, candidate queries, page metadata,
relation pagination, nested blocks and SDK retries all use that exact budget.
The existing client AsyncLocalStorage binding consumes at the outbound fetch
boundary, and combines the budget AbortSignal with the SDK signal. Existing body
reading is also raced/cancelled against the budget. Search disposes its budget;
Knowledge retrieval leaves an externally supplied budget owned by its caller.
All standalone tools retain their existing default 20 attempts and 30 seconds.
Independent concurrent searches have separate budgets, cancellation and results.

Search snapshots have a 60-second TTL from insertion, at most 32 LRU entries and
1,000,000 serialized UTF-8 payload bytes in total. Oversized entries are not stored.
Keys include normalized query, lowercase UUIDs, sorted Type/Verification/tags,
depth and limit. Keys are additionally bounded by input limits; Map/object overhead
is not included in the payload-byte counter. Cache only result DTOs and diagnostics,
never configuration, headers, credentials or full bodies.

Expired entries are removed lazily on the next search. Concurrent misses execute
independently, rather than sharing cancellation or request budgets. Cached snapshots
are serialized and reparsed to prevent caller mutation. Cache hits explicitly report
`countsSource: cached_snapshot`, original evaluation time/counts, `cacheAgeMs`, and
zero current outbound requests. The original truncation flags remain intact.

Only fully evaluated snapshots (or solely `result_limit` truncation) are cached.
Incomplete scans/bodies are not cached. If auto reused the pre-existing 30-second
body cache, its result is not inserted into the 60-second search cache, preventing
an extra search TTL from extending that cached body's freshness window.

Bootstrap wires capture invalidation after confirmed create, after append completion,
and after partial/unknown outcomes. A generation guard stops in-flight searches
from repopulating an invalidated cache. Cache maintenance cannot change capture
write/recovery semantics. This is process-local acceleration, not a source of truth.
External edits, permission changes and writes handled by other processes may stay
in a search snapshot until expiry. Cold starts and different Vercel instances have
independent caches. Results are not an atomic Notion snapshot; moving pagination
can fail safely on duplicate IDs/cursors or miss concurrent edits within the bounds.

## Local evidence and limitations

The deterministic golden fixture covers exact/partial titles, context, paths, tags,
URL, body-only, multiple fields, phrase relevance, similar irrelevant words, no
matches and different scopes/Types/statuses. Tests assert numeric ordering and
exercise SDK filters, retries, nested blocks, deadlines, byte/LRU cache bounds,
TTL, partial results and MCP text/structured contracts. Existing tools retain
their regression suites. Source/compiled stdio and stateless HTTP invocation are
tested with synthetic upstream responses only.

Run `npm run check` with Node 24.22.1. Live Notion, actual editor invocation and
hosted KAN-15 acceptance are NOT RUN. Nothing here establishes live production
search acceptance. The Jira connector was unavailable during implementation;
the supplied KAN-15 specification defines this change's scope.
