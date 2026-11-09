import { createFixtureApi } from "./notion.ts";

// Child-process startup test: synthetic metadata only; no network or .env access.
globalThis.fetch = createFixtureApi().fetch;
