# Contributing to mpq-js

Thanks for your interest in improving mpq-js.

## Getting started

```bash
git clone https://github.com/jeany55/mpq-js.git
cd mpq-js
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

## Adding to the public API

Anything consumers should use must be re-exported from `src/index.ts`. Export
types with `export type { ... }` — the build transpiles each file in isolation
and cannot tell a type from a value otherwise.

## Releasing

Releases are automated. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
verifies, builds, checks that the tag matches `package.json`, and publishes to
npm with provenance.

1. Make sure `main` is green and update `CHANGELOG.md`.
2. Bump the version and create the tag:
   ```bash
   npm version patch   # or minor / major
   ```
3. Push the commit and the tag:
   ```bash
   git push --follow-tags
   ```

The workflow needs an `NPM_TOKEN` repository secret (an npm **Automation**
access token).
