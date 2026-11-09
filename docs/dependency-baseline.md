# Dependency baseline (KAN-4)

Status: verified candidates for future initialization; no production dependencies
installed. Verification snapshot: 9 November 2026, Windows x64.

## Exact approved versions

| Component | Version | Role and compatibility evidence |
|---|---|---|
| Node.js LTS | `24.22.1` | Verification runtime; official distribution checksum verified |
| TypeScript | `6.0.3` | Strict compilation passed with library checking enabled |
| `@modelcontextprotocol/server` | `2.4.0` | Official stable v2 SDK; Node >=20 |
| `@modelcontextprotocol/node` | `2.1.2` | Node >=20; server peer range `^2.4.0` accepts the selected server |
| `@notionhq/client` | `5.28.0` | Node >=18; published SDK supports API `2025-09-03` |
| `zod` | `4.6.7` | Satisfies SDK dependency range; type/import checks passed |
| `pino` | `10.4.0` | Structured logger; resolved engines and stderr logging passed |
| `vitest` | `5.0.5` | Selected Node, Vite, and Node-types requirements satisfied |
| `vite` | `8.3.5` | Required Vitest peer; Node engine check passed |
| `@types/node` | `24.19.2` | Node 24 declarations; TypeScript 6 check passed |

npm `11.19.1` was the verification tool version. Express is not required or part
of the direct baseline. Different MCP adapter/server version numbers are valid;
compatibility follows the adapter's declared peer range.

The Notion SDK supports and defaults to API `2025-09-03`; explicitly select
`notionVersion: "2025-09-03"` in future code. This does not prove authentication
or record-writing capability.

The future manifest split is documented below; no root manifest is created:

```json
{
  "engines": {
    "node": ">=24.22.1 <25"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.4.0",
    "@modelcontextprotocol/node": "2.1.2",
    "@notionhq/client": "5.28.0",
    "zod": "4.6.7",
    "pino": "10.4.0"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "@types/node": "24.19.2",
    "vitest": "5.0.5",
    "vite": "8.3.5"
  }
}
```

## Approved npm overrides

These accompany the exact direct versions and verified lockfile in a future root
manifest. All override values are exact pins.

```json
{
  "overrides": {
    "@hono/node-server": "2.1.5",
    "hono": "4.13.14",
    "rolldown": "1.2.15",
    "@types/estree": "1.0.9",
    "magic-string": "1.4.3",
    "postcss": "8.5.31",
    "thread-stream": "4.2.0",
    "tinybench": "6.2.2",
    "@rolldown/pluginutils": "1.0.1"
  }
}
```

| Override | Publication date (UTC) |
|---|---|
| `@hono/node-server@2.1.5` | 2026-10-13 |
| `hono@4.13.14` | 2026-10-25 |
| `rolldown@1.2.15` | 2026-10-21 |
| `@types/estree@1.0.9` | 2026-05-06 |
| `magic-string@1.4.3` | 2026-10-05 |
| `postcss@8.5.31` | 2026-10-18 |
| `thread-stream@4.2.0` | 2026-05-14 |
| `tinybench@6.2.2` | 2026-10-10 |
| `@rolldown/pluginutils@1.0.1` | 2026-05-13 |

All overrides satisfy original parent dependency ranges. Rolldown `1.2.15`
selects all 15 matching optional bindings at `1.2.15` (published 21 October)
and `@oxc-project/types@0.155.0` (19 October 2026). Separate overrides for
those exact-version dependencies are unnecessary.

## Maturity and complete-tree verification

The conservative cutoff was **26 October 2026, 00:00 IST**
(`2026-10-26T00:00:00+05:30`), preserving the 14-day rule for the verification.
The cutoff was not relaxed.

Initial normal resolution selected 24 entries newer than the cutoff. During
re-resolution, a newly published `@rolldown/pluginutils` also required an
override. Every final third-party lockfile entry was checked against registry
publication times, including optional packages not installed on Windows.

| Final check | Recorded result |
|---|---|
| Third-party lockfile entries | 83 |
| Installed entries on Windows x64 | 58 |
| Transitive entries / installed transitive entries | 74 / 49 |
| Optional entries included in verification | 27 |
| Maturity violations | 0 |
| Required peer / engine / original dependency-range conflicts | 0 / 0 / 0 |
| Prerelease / deprecated entries | 0 / 0 |
| Registry metadata failures | 0 |
| Strict installation and `npm ls --all` | PASS, exit 0 |
| Import checks | 8/8 PASS |
| TypeScript | PASS, strict and `skipLibCheck: false` |
| Vitest smoke test | 1/1 PASS |

Installation used `--ignore-scripts --strict-peer-deps --engine-strict --no-audit --no-fund`.
No vulnerability audit result is claimed. Other-platform packages received
metadata, range, and engine checks; their binaries were not executed.

## TypeScript 6 requirements

Explicitly include Node types: TypeScript 6 defaults `types` to an empty array.
A separate Node-globals check failed as expected without Node types and passed
with them. The successful temporary configuration included:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2023", "DOM"]
  }
}
```

## Verified lockfile and source evidence

SHA-256 of the final KAN-4 lockfile, unchanged during KAN-5:

```text
AD1B7FDAB404A4CCA2750D7FB88DC63A22DF441FB067EC30CD62F0F169C9FBD1
```

These machine-local temporary directories still existed when documentation was
written:

```text
C:\Users\DESK0034\AppData\Local\Temp\devmemory-kan4-mature-42d119e6ea5c4dd4adaf93fa172430b6
C:\Users\DESK0034\AppData\Local\Temp\devmemory-kan5-faf034f50751420481c2da0ae3087256
```

KAN-4 evidence includes `package.json`, `package-lock.json`,
`verification-results.json`, `validation-summary.json`,
`dependency-inventory.json`, and `dependency-tree.json`. The lockfile hashes
in both directories were rechecked while documenting.

Raw artifacts remain outside this repository and may expire through temp cleanup.
Before bootstrap, recover and verify that lockfile. If unavailable, regenerate in
isolation and repeat full verification: its hash alone cannot recreate it.
No production manifest, lockfile, installation, or bootstrap was created here.

Vercel hosted deployment is **NOT YET VERIFIED**. Its managed patch policy also
prevents guaranteeing the exact local runtime or runtime maturity age. See
[compatibility results](mcp-compatibility-spike.md).

## Official references used during verification

Registry checks used `https://registry.npmjs.org/<package>` publication times
and version metadata.

- [Node 24.22.1 release](https://nodejs.org/en/blog/release/v24.22.1)
- [Official MCP v2 SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Published Notion SDK 5.28.0 README](https://unpkg.com/@notionhq/client@5.28.0/README.md)
- [Zod requirements](https://zod.dev/)
- [Vitest requirements](https://vitest.dev/guide/)
- [TypeScript 6 type inclusion](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#types-now-defaults-to-)
- [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides)
