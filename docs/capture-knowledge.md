# Knowledge capture (KAN-14)

`capture_knowledge` is create-only and non-idempotent. Both existing transports
use the shared service. It has no update, delete, overwrite or resume endpoint.
Notion remains the only source of truth. The subsequent shared-code audit fixes
KAN-13's caption/fence defects separately from capture implementation; KAN-13
live/hosted acceptance is not claimed.

## Input and verification policy

Required: `projectId` (page UUID), `title` and `type`. Optional: `subprojectId`,
`content`, `context`, `filePaths`, `sourceUrl`, `tags`, `verification`.

| Field | Bound / format |
|---|---|
| IDs | Canonical UUIDs, normalized to lowercase |
| Title | Trimmed nonblank, 1-200 UTF-16 code units |
| Content | Nonblank when supplied, at most 20,000 code units |
| Context | Trimmed nonblank, at most 2,000 code units |
| File paths | 1-10 unique trimmed paths, each 1-200 code units |
| Source URL | At most 2,000 characters, HTTP(S), no embedded credentials |
| Tags | Unique exact schema options, at most 9 |
| Complete normalized input | At most 48,000 UTF-8 JSON bytes |
| Combined input elements | At most 16 object members plus array items, including default Verification |

The existing MCP 16-element guard and HTTP 64 KiB request ceiling are unchanged.
Array maxima are conditional on the combined limit. Unknown fields and option
values are rejected before any read or write. Empty tags can explicitly select
no tags; other optional fields are omitted when absent.

Type and Tags come from the existing verified schema map, not invented options.
Type options: Implementation, Technical Decision, Error & Fix, Setup / Runbook,
Reference, Learning. Tags: architecture, frontend, backend, database, deployment,
debugging, auth, performance, testing.

Only Draft (default), Hypothesis and Needs Review are writable. The service and
repository both validate this restriction independently of MCP input validation.
Verified is rejected with a human-review explanation; a human must manually mark
the entry Verified in Notion after checking it. No automatic promotion occurs.

## Workflow and schema protection

1. Validate input and convert the bounded body locally.
2. Reuse the existing project/subproject repository and shared scope validator.
3. Scan at most 500 Knowledge records in the selected project for duplicate
   titles, using pages of at most 100. Comparison trims, collapses whitespace
   and lowercases. A duplicate emits DUPLICATE_TITLE and does not block creation.
   A capped scan emits DUPLICATE_CHECK_INCOMPLETE; it is not a uniqueness guarantee.
4. Refresh the Knowledge data-source schema. Require the approved property IDs,
   types, exact option sets and existing relation targets to match. Require option
   IDs; missing IDs or drift fail before mutation. This uses the current API
   response at invocation time, not credentials or a repository .env read.
5. Reserve enough remaining attempts for creation and all planned append batches.
6. Create one page under the resolved Knowledge data source, mapping only Name,
   Type, Verification, Context / Environment, Files / Paths, Source URL, Tags,
   Project and optional Subproject. File paths are joined with newlines.
7. Append converted body blocks in order, separately from page creation.

Select and multi-select writes use existing option IDs, never option names, so
the request cannot implicitly add select options. Preflight bindings are frozen,
budget-bound and single-use. Append access is restricted to pages newly created
by the writer under that same budget. No schema-mutation APIs are exposed.

Schema/permission changes and duplicate captures can race after validation;
Notion does not provide a cross-request transaction here. This is warning-only
duplicate detection, not locking or an exactly-once/idempotency guarantee.

## Markdown and API limits

The converter supports paragraphs, headings 1-3, flat bulleted/numbered lists,
tasks, quotes, dividers and backtick/tilde fenced code. Other inline Markdown,
links, tables and indented layout are preserved as literal text. It does not
download media or build a full Markdown document model. Unknown code languages
are stored as plain text. Blank separators become block boundaries.

At most 500 flat body blocks are allowed; excess fails before I/O. Rich text is
split into at most 2,000-code-unit text segments without splitting surrogate
pairs, with at most 100 rich-text elements per field/block. Append requests have
at most 100 blocks and serialized payloads are capped at 450,000 bytes, below
Notion's documented request ceilings. See [Notion request limits](https://developers.notion.com/reference/request-limits)
and [append limits](https://developers.notion.com/reference/patch-block-children).

## Budget, retries and recovery

One existing 20-attempt, 30-second monotonic request budget covers scope reads,
duplicate queries, fresh schema validation, SDK read retries, creation, appends
and response-body consumption. Read retry behavior is unchanged. Mutations are
single-attempt: guarded SDK fetches turn mutation HTTP failures into application
errors before SDK retry construction. A second mutation fetch is also denied.
No automatic page-creation or append replay occurs, including 429/529 responses.

Before creation, configuration, schema, scope, read or attempt failures produce
safe errors and zero mutation calls. The write deadline is enforced inside the
repository so a confirmed creation identity survives a subsequent append timeout.
The service always disposes its invocation budget and cancels orphaned I/O.

After confirmed creation, an append failure returns isError with code PARTIAL_WRITE,
retryable false and a separate recovery object containing pageId, URL, confirmed
batches/blocks, total batches/blocks, bodyComplete, failedBatchOutcome and
doNotRetryCapture true. The failed batch may have an unknown outcome; only earlier
acknowledged batches are counted as confirmed. Never assume it wrote zero blocks.
Inspect the existing page and complete it manually; retrying capture creates a
new page. Recovery identifiers are returned to the caller, never logged.

If creation was sent but its result cannot be confirmed (network/timeout, 5xx,
malformed success or lost response), WRITE_OUTCOME_UNKNOWN is non-retryable.
There may be a page in Notion, but no reliable page ID is available. Inspect
Notion before retrying. Cancellation cannot undo a remote write. Late responses
cannot trigger appends or be published as successful captures. No rollback is
attempted and there is no persistent deduplication ledger.

If creation and every requested body batch were confirmed before the final
deadline check fails, WRITE_CONFIRMED_AFTER_DEADLINE returns non-retryable recovery
with bodyComplete true. It is not PARTIAL_WRITE or an unknown remote outcome,
and is never published as an on-time success. Do not repeat the capture.

## Verification boundary

KAN-15 wires process-local search cache invalidation after confirmed creation,
after append completion, and after partial or unknown write outcomes. A generation
guard prevents an overlapping search from storing an invalidated snapshot. Cache
maintenance does not alter confirmed-write or recovery semantics. Other processes
and external Notion changes are observed after search cache expiry (60 seconds).

Automated write tests use mocks and controlled fixtures only. No live Notion
records are created for tests. Run npm run check with Node 24.22.1. A separately
approved manual capture would require read and insert-content permissions; no
live or hosted write acceptance is claimed by these tests.
