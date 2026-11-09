# Notion integration boundary

All Notion SDK imports and SDK-specific types belong exclusively here. The client
reuses validated configuration and API version 2025-09-03, and exposes only an
application-owned read-only metadata interface. Database/data-source retrievals
are implemented; record operations and schema writes are not.
