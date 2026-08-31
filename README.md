# mpq-js

[![npm version](https://img.shields.io/npm/v/mpq-js.svg)](https://www.npmjs.com/package/mpq-js)
[![CI](https://github.com/jeany55/mpq-js/actions/workflows/ci.yml/badge.svg)](https://github.com/jeany55/mpq-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mpq-js.svg)](./LICENSE)

A universal JavaScript/TypeScript library for reading and creating **MPQ (MoPaQ)** archive files — the format used by Blizzard Entertainment games (Warcraft III, StarCraft, Diablo II, etc.).

Runs the same code in **Node.js, browsers, Deno, Bun, and edge runtimes** — no Node built-ins, no polyfills, no bundler configuration.

## Features

- **Read** MPQ v1 archives — extract files by name
- **Create** MPQ v1 archives — add files with optional compression and encryption
- **List files** via the embedded `(listfile)`
- **Full TypeScript types** with true dual CommonJS and ESM builds
- **Runs everywhere** — no Node built-ins; the browser gets the full sync *and* async API
- **One tiny dependency** — [fflate](https://github.com/101arrowz/fflate) (~4 kB gzipped)
- Supports zlib compression (read/write) and encrypted files with key adjustment

## Installation

```bash
npm install mpq-js
```

**Requirements:** Node.js 18+, or any modern browser. Both module systems work out
of the box:

```js
import { Archive, Creator } from 'mpq-js'; // ESM
const { Archive, Creator } = require('mpq-js'); // CommonJS
```

## Usage

### Reading an MPQ archive

```typescript
import { Archive } from 'mpq-js';
import * as fs from 'fs';

const data = fs.readFileSync('game.w3x');
const archive = Archive.open(data);

// List all files
const files = archive.files();
console.log(files); // ['war3map.j', 'war3map.w3e', ...]

// Extract a file
const fileData = archive.readFile('war3map.j');
fs.writeFileSync('war3map.j', fileData);
```

### Creating an MPQ archive

```typescript
import { Creator } from 'mpq-js';
import * as fs from 'fs';

const creator = new Creator();

// Add files with various options
creator.addFile('readme.txt', Buffer.from('Hello, World!'));
creator.addFile('data/config.ini', Buffer.from('[settings]\nkey=value'), {
  compress: true,
});
creator.addFile('scripts/main.j', Buffer.from('function main() {}'), {
  compress: true,
  encrypt: true,
  adjustKey: true,
});

// Write the archive
const archive = creator.write();
fs.writeFileSync('output.mpq', archive);
```

### Async API

Every method has a native `Promise`-based async counterpart that moves compression off the main thread (`worker_threads` in Node, a Web Worker in the browser):

```typescript
import { Archive, Creator } from 'mpq-js';
import * as fs from 'fs/promises';

// Create asynchronously
const creator = new Creator();
creator.addFile('data.txt', Buffer.from('async content'), { compress: true });
const archiveBuf = await creator.writeAsync();
await fs.writeFile('output.mpq', archiveBuf);

// Read asynchronously
const data = await fs.readFile('game.w3x');
const archive = await Archive.openAsync(data);
const files = await archive.filesAsync();
const fileData = await archive.readFileAsync('war3map.j');
```

### In the browser

The library is environment-agnostic — the exact same API, sync and async alike.
Load an archive from a `<input type="file">`, a `fetch`, or drag-and-drop:

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
Web Worker, so large archives don't freeze the UI. (Under a `worker-src` CSP that
forbids Workers, they transparently fall back to running on-thread.) For heavy
work, run the whole library inside your own Worker and use the sync methods.

### Error handling

```typescript
import { Archive, MpqError } from 'mpq-js';

try {
  const archive = Archive.open(someData);
  const file = archive.readFile('missing.txt');
} catch (err) {
  if (err instanceof MpqError) {
    switch (err.kind) {
      case 'NoHeader':     // No valid MPQ header found
      case 'FileNotFound': // File not in the archive
      case 'Corrupted':    // Data integrity failure
      case 'UnsupportedVersion': // MPQ version not supported
      case 'UnsupportedCompression': // Compression method not supported
        console.error(err.message);
        break;
    }
  }
}
```

## API

### `Archive`

| Method | Description |
|--------|-------------|
| `Archive.open(data: Uint8Array): Archive` | Open an MPQ archive from a buffer (sync) |
| `Archive.openAsync(data: Uint8Array): Promise<Archive>` | Open an MPQ archive from a buffer (async) |
| `archive.readFile(name: string): Uint8Array` | Extract a file by name (sync) |
| `archive.readFileAsync(name: string): Promise<Uint8Array>` | Extract a file by name (async, off-thread) |
| `archive.files(): string[] \| null` | List files via `(listfile)` (sync) |
| `archive.filesAsync(): Promise<string[] \| null>` | List files via `(listfile)` (async) |
| `archive.start: number` | Byte offset of archive start |
| `archive.end: number` | Byte offset of archive end |
| `archive.size: number` | Archive size in bytes |

### `Creator`

| Method | Description |
|--------|-------------|
| `new Creator(sectorSize?: number)` | Create a new archive builder (default sector: 65536) |
| `creator.addFile(name: string, data: Uint8Array, options?: FileOptions)` | Stage a file for inclusion |
| `creator.write(): Uint8Array` | Build and return the complete archive (sync) |
| `creator.writeAsync(): Promise<Uint8Array>` | Build and return the complete archive (async, off-thread) |

### `FileOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `compress` | `boolean` | `false` | Compress file data with zlib |
| `encrypt` | `boolean` | `false` | Encrypt file data |
| `adjustKey` | `boolean` | `false` | Adjust encryption key by file offset/size |

## Format Support

- **MPQ Version 1** (v0 format_version) — the format used by Warcraft III and earlier titles
- **Compression**: zlib (read/write)
- **Encryption**: Full MPQ encryption with optional key adjustment
- **Sector-based storage** with configurable sector size

## Runtime Support

| Runtime | Sync API | Async API |
|---------|----------|-----------|
| Node.js 18+ | ✅ | ✅ (`worker_threads`) |
| Modern browsers | ✅ | ✅ (Web Worker) |
| Deno / Bun | ✅ | ✅ |
| Edge / Workers | ✅ | ✅ (falls back on-thread if Workers are unavailable) |

`Archive.open()` and `creator.addFile()` take any `Uint8Array`, which includes a
Node.js `Buffer`. Outputs are always plain `Uint8Array`.

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

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
