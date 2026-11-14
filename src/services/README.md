# Shared services boundary

Services are shared independently of MCP transports. The Notion schema service resolves
database data sources and validates metadata at startup, caching successful
results for the application lifecycle. Project listing validates inputs, pushes
status filtering to the repository, and applies case-insensitive name matching
to one bounded page. It preserves the upstream continuation cursor, including
when there are no matches on that page. Services expose application-owned DTOs.

Project context validates project/subproject scope, coordinates independent
knowledge lists and grouped counts, and returns scan completeness information.
One invocation budget is shared across repository reads, relation pagination and
SDK retries. No service imports Notion SDK types or calls a transport directly.
