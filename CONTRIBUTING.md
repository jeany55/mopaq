# Contributing to mopaq

Thanks for your interest in improving mopaq.

## Getting started

```bash
git clone https://github.com/jeany55/mopaq.git
cd mopaq
npm install
npm run verify
```

Node.js 18 or newer is required.

## Project layout

| Path | Purpose |
|------|---------|
| `src/` | Library source. `src/index.ts` is the only public entry point. |
| `tests/` | `node:test` suites, run directly against TypeScript via `tsx`. |
| `tsdown.config.mts` | Build config — bundles `src/index.ts` to ESM + CJS + types. |
| `dist/` | Build output. Generated; never committed. |

## Scripts

| Script | What it does |
|--------|--------------|
| `npm test` | Runs the test suite against the TypeScript sources (no build step). |
| `npm run typecheck` | Type-checks `src`, `tests`, and the build config. |
| `npm run build` | Produces `dist/index.mjs`, `dist/index.cjs`, and matching `.d.mts` / `.d.cts`. |
| `npm run check:publish` | `publint` — validates the published package layout. |
| `npm run check:exports` | `attw` — validates that types resolve for ESM, CJS, and bundlers. |
| `npm run verify` | All of the above, in order. Run this before opening a PR. |

## Staying universal

This library must run in browsers, Deno, Bun and edge runtimes as well as Node.
That means **no Node built-ins and no Node-only globals in `src/`** — no
`node:zlib`, no `Buffer`, no `process`. Compression goes through
[fflate](https://github.com/101arrowz/fflate) instead.

`tests/universal.test.ts` enforces this and will fail the build if a Node
import or global creeps back in. Accept `Uint8Array` in public signatures; a
Node `Buffer` already is one, so it keeps working without the type dependency.

Note that MPQ stores **zlib-wrapped** DEFLATE (RFC 1950), so `src/compression.ts`
uses fflate's `zlibSync`/`unzlibSync` — *not* `deflateSync`/`inflateSync`, which
produce raw DEFLATE and would silently write archives no other MPQ tool can read.

## Adding to the public API

Anything consumers should use must be re-exported from `src/index.ts`. Export
types with `export type { ... }` — the build transpiles each file in isolation
and cannot tell a type from a value otherwise.

## Releasing

Pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
verifies, builds, checks the tag against `package.json`, and publishes.

1. Make sure `main` is green and update `CHANGELOG.md`.
2. Bump the version and create the tag:
   ```bash
   npm version patch   # or minor / major
   ```
3. Push the commit and the tag:
   ```bash
   git push --follow-tags
   ```

Publishing uses npm trusted publishing, so there is no token to rotate. npm
verifies a short-lived OIDC token from GitHub Actions, which is why the job
needs `id-token: write` and why the trusted publisher registered on npm has to
name this repository and `release.yml` exactly. Rename either one and publishes
start failing until the npm side is updated to match.

Provenance is attached automatically, so the workflow does not pass
`--provenance`. Trusted publishing needs npm 11.5.1 or newer, and the Node 22
runner still bundles npm 10, hence the explicit npm upgrade step before
anything else runs.
