# Notion integration boundary

All Notion SDK imports and SDK-specific types belong exclusively here. The client
reuses validated configuration and API version 2025-09-03, and exposes only an
application-owned metadata and project repository interfaces. Database/data-source
retrievals and bounded project queries are implemented. The fetch guard permits
metadata GETs and POST /query only for the resolved Projects data source. All
other endpoint/method combinations and redirects are denied. Record writes and
schema changes are not exposed. SDK types and raw payloads never reach services.
