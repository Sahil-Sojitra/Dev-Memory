# Notion integration boundary

All Notion SDK imports and SDK-specific types belong exclusively here. The client
reuses validated configuration and API version 2025-09-03, and exposes only an
application-owned metadata, project-listing and project-context repository
interfaces. The fetch guard permits metadata GETs and bounded project queries.
Within a context request budget it additionally permits page retrieval, paginated
Project relation reads, and queries against the three validated data sources.
All other endpoint/method combinations and redirects are denied. Outbound attempts,
including SDK retries, consume the context invocation's shared budget. Record
writes and schema changes are not exposed. SDK types and raw payloads never reach services.
