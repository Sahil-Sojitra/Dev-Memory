# Knowledge entry (KAN-13)

`get_knowledge_entry` is a read-only tool registered in the shared MCP factory
for both existing transports. Input is `{ "pageId": "<Knowledge page UUID>" }`.
UUIDs are normalized to lowercase and unknown input fields are rejected safely.
It uses the existing Notion client, API version and validated Knowledge schema.
No search, writes, new properties or dependencies are introduced.

## Response and errors

`entry` includes ID, URL, `title` (also `name` for consistency with existing DTOs),
optional Type/Verification/Context/Files/Source URL, Tags, Created and Last Updated,
and `projectIds` / `subprojectIds`. Property names are mapped by their validated IDs.
Created and Last Updated come from the verified system properties. Unset optional
properties retain the existing mapper's omitted-field convention.

Inline relations with `has_more` are paginated, bounded to 1,000 unique IDs per
relation and the shared request budget. `relationsTruncated` and
`relationTruncationReasons` identify incomplete metadata (`relation_limit` or
`request_budget`). Partial relations are never presented as complete.

`content` contains Markdown, `blocksRead`, `unsupportedBlocks`, `truncated` and
`reasons`. The top-level `truncated` combines body and relation completeness.
`requestBudget` reports outbound attempts for this invocation; `cacheHit` applies
only to the body, never to permission/parent/metadata validation.

Missing, archived or trashed pages return `NOT_FOUND`. A readable page outside
the configured Knowledge data source returns `NOT_IN_KNOWLEDGE_DB`; its body is
never requested. Invalid input uses the existing safe input-validation path.
Vendor errors are mapped through the existing sanitized error system. No entry
IDs, body text, headers or credentials are added to diagnostic logs.

## Markdown and bounded traversal

Supported blocks: paragraphs, headings 1-3, bulleted/numbered lists, checkboxes,
quotes, callouts, toggles, fenced code, dividers, equations, table rows, tables,
columns/column lists, synced-block children and media/bookmark/embed links.
Tables are readable pipe-delimited rows; no inferred header schema is added.
Rich text preserves bold, italic, strike-through, inline code and safe links.
Code text is preserved with fences long enough to contain embedded backticks.
Code captions follow their fenced block and remain part of cached complete
content. Fence calculation is iterative, so very large backtick-heavy blocks
reach the normal content/truncation limits without argument-spread failures.
Literal block-leading Markdown is escaped; child prefixes preserve numbered-list
indentation and blockquote context. Layout conversion remains bounded and partial.
Media is linked, never downloaded. Only HTTP(S)/mailto links are emitted.

Unsupported blocks have visible placeholders, increment `unsupportedBlocks` and
mark the body truncated with `unsupported_block`. Child pages are identified but
not recursively fetched as separate pages. Unsupported block descendants are
not expanded. This is a readable Markdown/text conversion, not a lossless Notion
export: layout, colors, underline and arbitrary embedded applications are omitted.

- 20 outbound attempts and the existing 30-second monotonic overall deadline
  for standalone retrieval. Search supplies its own shared 40-attempt budget;
  nested body work uses that same caller-owned budget, not a separate allowance.
- Every page/property/block request and SDK retry consumes the same budget.
- Child lists use pages of at most 100. Repeated cursors and duplicate block IDs
  fail safely; no unbounded traversal is attempted.
- Root depth is 0; children are expanded through depth 5. Deeper content records
  `depth_limit`. At most 500 blocks are rendered and 100,000 JavaScript string
  characters emitted (`block_limit` / `content_limit`). A cut can interrupt Markdown.
- Attempt exhaustion after required metadata validation returns accumulated body
  content with `request_budget`. If validation itself cannot finish, it fails.
- Overall deadline expiry rejects the operation with `REQUEST_BUDGET_EXCEEDED`,
  following KAN-12 semantics; it cannot publish a late partial success. Earlier
  SDK timeouts remain `TIMEOUT`. Fetch/body cancellation and late-result rejection
  reuse the existing adapter, including retries and relation/block pagination.

## Body cache and freshness

The optional body cache is process-local and evictable: at most 32 entries,
1,000,000 Markdown characters, and a 30-second TTL. Only complete bodies are
stored. Keys contain the page ID and Last Updated; every call first rereads and
validates metadata. Changed timestamps invalidate the page's previous entry.
It introduces no persistence, external cache or session dependency. A cold
instance reads Notion normally; content is never available from cache alone.

This is not a transactional snapshot. Concurrent edits can change metadata or
body while it is being read. A descendant edit not reflected in the parent page's
Last Updated can remain cached until TTL expiry. Cached media URLs may expire;
the cache is an optimization, not a freshness or availability guarantee.

## Verification boundary

Unit, repository-through-installed-SDK, MCP adapter, source/compiled stdio and
HTTP tests use synthetic data exclusively. They cover supported/unsupported and
nested blocks, limits, safe identity errors, relation pagination, retries, body
cancellation, partial content and cache invalidation/eviction. Run `npm run check`
with Node 24.22.1. No live Notion or hosted acceptance is implied by these tests.
