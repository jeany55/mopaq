<div align="center">

# mpq-js

**Read and write MPQ (MoPaQ) archives — Blizzard's format for Warcraft III, StarCraft and Diablo II — anywhere JavaScript runs.**

[![npm version](https://img.shields.io/npm/v/mpq-js.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/mpq-js)
[![CI](https://img.shields.io/github/actions/workflow/status/jeany55/mpq-js/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/jeany55/mpq-js/actions/workflows/ci.yml)
[![types included](https://img.shields.io/badge/types-included-3178c6?style=flat-square&logo=typescript&logoColor=white)](#typescript-first)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/mpq-js?style=flat-square)](https://bundlephobia.com/package/mpq-js)
[![license](https://img.shields.io/npm/l/mpq-js.svg?style=flat-square)](./LICENSE)

</div>

```typescript
import { Archive } from 'mpq-js';

const archive = await Archive.openAsync(bytes);
const script = await archive.readFileAsync('war3map.j');
```

No Node built-ins, no polyfills, no bundler configuration — the same build runs
in **Node.js, browsers, Deno, Bun and edge runtimes**, with a Promise-based API
alongside every synchronous one.

## Highlights

- 🧩 **TypeScript-first** — written in TypeScript, ships hand-checked declarations for both ESM and CommonJS, and is verified on every commit by [`publint`](https://publint.dev) and [`are-the-types-wrong`](https://arethetypeswrong.github.io).
- ⚡ **Promises everywhere** — every public method has a native `async` counterpart. No callbacks, no `promisify`, no wrapper package.
- 🌍 **Truly universal** — zero Node built-ins, so the browser gets the *full* sync and async API, not a reduced one.
- 📖 **Read** MPQ v1 archives — extract files by name, list contents via the embedded `(listfile)`.
- 📦 **Create** MPQ v1 archives — stage files with optional zlib compression and MPQ encryption.
- 🪶 **Small** — one dependency, [fflate](https://github.com/101arrowz/fflate); the library itself is about 7.5 kB gzipped.

## Installation

```bash
npm install mpq-js
```

<details>
<summary>pnpm · yarn · bun · deno</summary>

```bash
pnpm add mpq-js
yarn add mpq-js
bun add mpq-js
deno add npm:mpq-js
```

</details>

**Requirements:** Node.js 18+, or any modern browser. Both module systems work
out of the box, with correct types for each:

```js
import { Archive, Creator } from 'mpq-js'; // ESM
const { Archive, Creator } = require('mpq-js'); // CommonJS
```

## Quick start

### Read an archive

```typescript
import { Archive } from 'mpq-js';
import * as fs from 'node:fs';

const archive = Archive.open(fs.readFileSync('game.w3x'));

archive.files();              // ['war3map.j', 'war3map.w3e', ...] — or null if no (listfile)
archive.readFile('war3map.j'); // Uint8Array
```

### Create an archive

```typescript
import { Creator } from 'mpq-js';
import * as fs from 'node:fs';

const creator = new Creator();

creator.addFile('readme.txt', new TextEncoder().encode('Hello, World!'));
creator.addFile('data/config.ini', configBytes, { compress: true });
creator.addFile('scripts/main.j', scriptBytes, {
  compress: true,
  encrypt: true,
  adjustKey: true,
});

fs.writeFileSync('output.mpq', creator.write());
```

A `(listfile)` is generated for you from the names you stage, so the archives
you write list their own contents in any MPQ tool.

## Promise support

Every public method has a native `Promise` twin — no callbacks and no
`util.promisify` anywhere in the package. The methods that compress or
decompress (`readFileAsync`, `writeAsync`, and `filesAsync`, which reads the
`(listfile)`) hand that work to a worker — `worker_threads` in Node.js, a Web
Worker in the browser — so the calling thread stays free. `openAsync` parses
headers on-thread and exists so an `await`-shaped pipeline stays consistent.

```typescript
import { Archive, Creator } from 'mpq-js';
import * as fs from 'node:fs/promises';

// Write, off-thread
const creator = new Creator();
creator.addFile('data.txt', bytes, { compress: true });
await fs.writeFile('output.mpq', await creator.writeAsync());

// Read, off-thread
const archive = await Archive.openAsync(await fs.readFile('game.w3x'));
const files = await archive.filesAsync();
const script = await archive.readFileAsync('war3map.j');
```

Where Workers are unavailable — a strict `worker-src` CSP, a runtime without
them — the async methods transparently fall back to running on-thread, so the
same code keeps working rather than throwing.

## TypeScript-first

The library is written in TypeScript and published as a true dual ESM/CommonJS
package, with a separate declaration file for each so `import` and `require`
consumers both resolve correct types. Every release is gated on `publint` and
`are-the-types-wrong` in CI, so no `"types"` misconfiguration ships.

```typescript
import { Archive, Creator, MpqError } from 'mpq-js';
import type { FileOptions, MpqErrorKind, FileHeader } from 'mpq-js';

const options: FileOptions = { compress: true, encrypt: true, adjustKey: true };

const files: string[] | null = archive.files(); // null is in the type — handle it
```

Public signatures take and return plain `Uint8Array`, never `Buffer`. A Node
`Buffer` *is* a `Uint8Array`, so it keeps working unchanged — while browser
consumers never need `@types/node` to build.

## In the browser

The exact same API, sync and async alike. Load an archive from an
`<input type="file">`, a `fetch`, or drag-and-drop:

```typescript
import { Archive } from 'mpq-js';

// From a file picker
const file = input.files[0];
const archive = Archive.open(new Uint8Array(await file.arrayBuffer()));
console.log(archive.files());

// From the network
const res = await fetch('/maps/game.w3x');
const remote = await Archive.openAsync(new Uint8Array(await res.arrayBuffer()));
const script = await remote.readFileAsync('war3map.j');

// Offer an archive you built as a download
const blob = new Blob([creator.write()], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
```

Prefer the **async** methods on the main thread: they hand compression off to a
Web Worker, so large archives don't freeze the UI. For heavy work, run the whole
library inside your own Worker and use the sync methods.

## Error handling

Every failure is an `MpqError` carrying a discriminating `kind`, so you can
branch on the cause instead of matching on message strings.

```typescript
import { Archive, MpqError } from 'mpq-js';

try {
  const archive = Archive.open(someData);
  const file = archive.readFile('missing.txt');
} catch (err) {
  if (err instanceof MpqError) {
    switch (err.kind) {
      case 'NoHeader':               // No valid MPQ header found
      case 'FileNotFound':           // File not in the archive
      case 'Corrupted':              // Data integrity or decompression failure
      case 'UnsupportedVersion':     // MPQ version not supported
      case 'UnsupportedCompression': // Compression method not supported
      case 'IoError':                // Reserved for I/O failures
        console.error(err.kind, err.detail);
        break;
    }
  }
}
```

## API

### `Archive`

| Member | Description |
|--------|-------------|
| `Archive.open(data: Uint8Array): Archive` | Open an MPQ archive from a buffer |
| `Archive.openAsync(data: Uint8Array): Promise<Archive>` | Same, `Promise`-returning |
| `archive.readFile(name): Uint8Array` | Extract a file by name |
| `archive.readFileAsync(name): Promise<Uint8Array>` | Extract a file by name, decompressing off-thread |
| `archive.files(): string[] \| null` | List files via `(listfile)`; `null` if absent |
| `archive.filesAsync(): Promise<string[] \| null>` | Same, off-thread |
| `archive.start: number` | Byte offset of archive start |
| `archive.end: number` | Byte offset of archive end |
| `archive.size: number` | Archive size in bytes |

### `Creator`

| Member | Description |
|--------|-------------|
| `new Creator(sectorSize?: number)` | New archive builder (default sector size: 65536) |
| `creator.addFile(name, data, options?)` | Stage a file for inclusion |
| `creator.write(): Uint8Array` | Build and return the complete archive |
| `creator.writeAsync(): Promise<Uint8Array>` | Same, compressing off-thread |

### `FileOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `compress` | `boolean` | `false` | Compress file data with zlib |
| `encrypt` | `boolean` | `false` | Encrypt file data |
| `adjustKey` | `boolean` | `false` | Adjust encryption key by file offset/size |

### `MpqError`

| Member | Type | Description |
|--------|------|-------------|
| `err.kind` | `MpqErrorKind` | Discriminating cause — see [Error handling](#error-handling) |
| `err.detail` | `string \| undefined` | Human-readable specifics |

## Format support

- **MPQ Version 1** (`format_version` 0) — the format used by Warcraft III and earlier titles
- **Compression**: zlib (read and write)
- **Encryption**: full MPQ encryption, with optional key adjustment
- **Sector-based storage** with a configurable sector size

## Runtime support

| Runtime | Sync API | Async API |
|---------|:--------:|-----------|
| Node.js 18+ | ✅ | ✅ `worker_threads` |
| Modern browsers | ✅ | ✅ Web Worker |
| Deno / Bun | ✅ | ✅ |
| Edge / Workers | ✅ | ✅ falls back on-thread where Workers are unavailable |

## Development

```bash
npm install       # install dev dependencies
npm test          # run the test suite directly against the TypeScript sources
npm run typecheck # type-check src and tests
npm run build     # bundle ESM + CJS + .d.ts into dist/ with tsdown
npm run verify    # typecheck + test + build + publint + are-the-types-wrong
```

Releases are cut by pushing a `v*` tag; see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md)
for the project layout and the constraints that keep the library universal.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE) © Jeany
