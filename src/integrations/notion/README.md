# Notion integration boundary

All Notion SDK imports and SDK-specific types belong exclusively here. The client
reuses validated configuration and API version 2025-09-03, and exposes only an
application-owned metadata, project-listing and project-context repository
interfaces. The fetch guard permits metadata GETs and bounded project queries.
Within a context request budget it additionally permits page retrieval, paginated
Project relation reads, and queries against the three validated data sources.
KAN-13 additionally permits budget-scoped block-child GETs for bounded Knowledge
body retrieval after the service validates the page's Knowledge parent. Expanded
Knowledge relations use the same guarded property endpoint and request budget.
KAN-14 permits POST /pages only inside an exact single-use write capability,
followed by PATCH /blocks/{new-page-id}/children only for pages created by that
writer in the same request budget. It refreshes the Knowledge schema before
creation, binds existing option IDs and suppresses automatic mutation retries.
All other endpoint/method combinations and redirects are denied. Outbound attempts,
including read retries, consume the invocation's shared budget. Existing-record
updates, deletion and schema mutation are not exposed. SDK types and raw payloads
never reach services.
