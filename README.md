# mopaq

Read and write MPQ archives in JavaScript and TypeScript.

MPQ (also written MoPaQ) is the archive format Blizzard used for Warcraft III,
StarCraft and Diablo II. In practice you'll want this to pull apart map files
like `.w3x`, `.w3m` and `.scx`, or to build one.

[![npm](https://img.shields.io/npm/v/mopaq.svg)](https://www.npmjs.com/package/mopaq)
[![CI](https://github.com/jeany55/mopaq/actions/workflows/ci.yml/badge.svg)](https://github.com/jeany55/mopaq/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mopaq.svg)](./LICENSE)

The source contains no Node built-ins, so the same build runs in Node 18+,
browsers, Deno and Bun. Bundlers need no configuration and no polyfills. The
main archive operations have synchronous and Promise-returning forms, and the
package ships TypeScript declarations for both ESM and CommonJS.

## Install

```bash
npm install mopaq
```

## Reading an archive

```typescript
import { Archive } from 'mopaq';
import { readFileSync } from 'node:fs';

const archive = Archive.open(readFileSync('game.w3x'));

archive.files();               // ['war3map.j', 'war3map.w3e', ...]
archive.readFile('war3map.j'); // Uint8Array
```

`files()` reads the archive's embedded `(listfile)`. Not every MPQ has one, and
when it's missing you get `null` rather than an error. The archive may still
contain files; you just have to know their names to read them, because MPQ
stores name hashes rather than the names themselves. Pass listed names back
unchanged; paths inside existing archives use backslashes, for example
`archive.readFile('scripts\\main.j')`.

## Writing an archive

```typescript
import { Creator } from 'mopaq';
import { writeFileSync } from 'node:fs';

const creator = new Creator();

creator.addFile('readme.txt', new TextEncoder().encode('hello'));
creator.addFile('data/config.ini', configBytes, { compress: true });
creator.addFile('staredit/scenario.chk', scenarioBytes, {
  compress: 'pkware',
  encrypt: true,
  adjustKey: true,
});

writeFileSync('output.mpq', creator.write());
```

Nothing is written until you call `write()`. A `(listfile)` is generated from
the names you staged, so archives you produce here list their own contents in
other MPQ tools. Forward slashes in names are converted to the backslashes MPQ
expects. `compress: true` is shorthand for zlib; use `compress: 'pkware'` when
targeting older games and tools that require PKWARE DCL.

## Promises

Opening, reading, listing, and writing each have an async counterpart. There are
no callbacks in the public API and nothing to `promisify`; the cheap staging and
metadata methods (`addFile` and `fileInfo`) stay synchronous.

```typescript
import { Archive, Creator } from 'mopaq';
import { readFile, writeFile } from 'node:fs/promises';

const archive = await Archive.openAsync(await readFile('game.w3x'));
const files = await archive.filesAsync();
const script = await archive.readFileAsync('war3map.j');

const creator = new Creator();
creator.addFile('data.txt', bytes, { compress: true });
await writeFile('out.mpq', await creator.writeAsync());
```

For zlib data, `readFileAsync`, `writeAsync`, and `filesAsync` (which reads the
`(listfile)`) hand compression work to `worker_threads` in Node or a Web Worker
in the browser. If workers aren't available, as under a strict `worker-src` CSP,
they quietly run on-thread instead of failing. PKWARE DCL uses mopaq's own
synchronous codec, so PKWARE work still runs on the calling thread when reached
through an async method.

`openAsync` is the exception. Parsing the header and hash tables is cheap and
stays on the calling thread; the method exists so an awaited pipeline doesn't
have one odd synchronous step in the middle.

## In the browser

Same API, nothing to configure. Get bytes from wherever, hand them over:

```typescript
// file picker
const archive = Archive.open(new Uint8Array(await file.arrayBuffer()));

// fetch
const res = await fetch('/maps/game.w3x');
const remote = await Archive.openAsync(new Uint8Array(await res.arrayBuffer()));

// download something you built
const blob = new Blob([creator.write()], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
```

Use the async methods on the main thread for zlib work. Large PKWARE operations
can still visibly freeze the page, so run those in your own worker. If you're
already inside a worker, the sync methods are usually simpler.

## Errors

Failures throw `MpqError`, which carries a `kind` you can switch on and an
optional `detail` string.

```typescript
import { Archive, MpqError } from 'mopaq';

try {
  Archive.open(data).readFile('missing.txt');
} catch (err) {
  if (err instanceof MpqError && err.kind === 'FileNotFound') {
    // ...
  }
}
```

| `kind` | Meaning |
|--------|---------|
| `NoHeader` | No MPQ header found in the data |
| `FileNotFound` | No file by that name in the archive |
| `Corrupted` | Malformed archive data or an invalid compressed stream |
| `UnsupportedVersion` | An MPQ version this library doesn't read |
| `UnsupportedCompression` | A compression method this library doesn't implement |
| `IoError` | Reserved; nothing throws this today |

## What's supported

Read and write MPQ version 1, the format used by Warcraft III and earlier games.
Later versions throw `UnsupportedVersion`.

Reading and writing handle zlib and PKWARE DCL. MPQ allows several other
methods, and a file using one of those throws `UnsupportedCompression`, naming
which one:

| Method | Status |
|--------|--------|
| zlib | Read and write |
| PKWARE DCL | Read and write |
| bzip2 | Not implemented |
| Huffman | Not implemented |
| IMA ADPCM (mono and stereo) | Not implemented |

PKWARE DCL matters more than its share of the format suggests: it is what
StarCraft, Diablo and many Warcraft III maps use for nearly every file, so
archives from those games are unreadable without it. Use zlib for better
compression with modern readers, or PKWARE when compatibility with older games
and Blizzard tools matters. On write, compression is attempted sector by sector;
a sector is stored raw when compression would not make it smaller.

The remaining three are audio and text codecs used inside game data archives.
If you hit one, the error tells you which method the file wanted.

Sector-based encryption is supported in both directions, including the key
adjustment some archives apply.

Files using MPQ's single-unit layout are not supported; the reader and writer
handle sector-based files. File lookup also has no locale selector when an
archive contains multiple localized entries with the same name.

## API

### Archive

| | |
|---|---|
| `Archive.open(data: Uint8Array): Archive` | Open an archive from bytes |
| `Archive.openAsync(data: Uint8Array): Promise<Archive>` | Same, Promise-returning |
| `archive.readFile(name: string): Uint8Array` | Read one file |
| `archive.readFileAsync(name: string): Promise<Uint8Array>` | Same, with worker-backed zlib decompression |
| `archive.files(): string[] \| null` | Names from `(listfile)`, or `null` if absent |
| `archive.filesAsync(): Promise<string[] \| null>` | Same, with worker-backed zlib decompression |
| `archive.fileInfo(name: string): FileInfo \| null` | Flags, sizes and the first sector's compression method, or `null` if absent |
| `archive.members(): StoredMember[]` | Every member the hash table names, `(listfile)` or not, each as stored — for `creator.addStored` |
| `archive.slotOf(name: string): number \| null` | The hash-table slot holding a name you know, to tell which member it is |
| `archive.hashEntries(): HashEntry[]` | A copy of the hash table, for `CreatorOptions.hashTable` |
| `archive.start` / `archive.end` / `archive.size` | Archive byte offsets and header-reported size |
| `archive.sectorSize` | Sector size in bytes, derived from the header |
| `archive.rawData` | The original `Uint8Array` passed to `open` |

`FileInfo` includes the raw block `flags`, compressed and uncompressed sizes,
`compressed`, `encrypted`, and `keyAdjusted` booleans, and `compression`. That
last field describes the first sector and can be `'none'`, `'zlib'`,
`'pkware'`, `'bzip2'`, `'huffman'`, an unknown numeric type byte, or `null` when
the sector cannot be inspected.

### Creator

| | |
|---|---|
| `new Creator(options?: number \| CreatorOptions)` | Configure the archive, or pass the sector size directly |
| `creator.addFile(name: string, data: Uint8Array, options?: FileOptions): void` | Stage a file; `/` in its name becomes `\\` |
| `creator.addStored(member: StoredMember): void` | Carry a member of another archive across as stored, at its offset and hash slot; needs `CreatorOptions.hashTable` and the same sector size |
| `creator.write(): Uint8Array` | Build the archive |
| `creator.writeAsync(): Promise<Uint8Array>` | Same, with worker-backed zlib compression |

### FileOptions

| Option | Default | Effect |
|--------|---------|--------|
| `compress` | `false` | `true` / `'zlib'` compresses with zlib; `'pkware'` with PKWARE DCL, what Blizzard's own tools wrote and every StarCraft and Diablo build reads |
| `encrypt` | `false` | Encrypt the file data |
| `adjustKey` | `false` | Adjust the encryption key by offset and size |

### CreatorOptions

| Option | Default | Effect |
|--------|---------|--------|
| `sectorSize` | `65536` | Sector size in bytes; Blizzard's StarCraft-era tools wrote 4096 |
| `listfile` | `true` | Write a `(listfile)` naming every file |
| `listfileCompress` | `'zlib'` | How the `(listfile)` is compressed |
| `hashTable` | none | Lay the hash table out over another archive's (`archive.hashEntries()`): same size, slots whose files are gone marked deleted, stored members at their slots |

### Rewriting an archive without every name

A `(listfile)` is optional and often removed, and without one a member can only be
found — or, when encrypted, decrypted — by a name you already know. To rewrite such
an archive without losing what you cannot name, carry the unnamed members across as
they are stored:

```ts
const a = Archive.open(bytes);
const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries() });
const scenario = a.slotOf('staredit\\scenario.chk');
for (const m of a.members()) if (m.slot !== scenario) c.addStored(m);
c.addFile('staredit\\scenario.chk', newScenario, { compress: 'pkware' });
const out = c.write();
```

A stored member is written back at the same offset with the same block entry and
keeps its hash-table slot; the new hash table has the old one's size, with every
slot whose file is gone marked *deleted* so lookups still probe past it. Named files
go into the gaps and after. That is what makes a member encrypted with an
offset-adjusted key readable afterwards without its name. The trade is that the
sector size cannot change and the hash table cannot grow (`HashTableFull`), and a
member overlapping another or the header is refused (`InvalidMember`).

### Standalone PKWARE DCL

`implode(data, options?)` and `explode(data, uncompressedSize)` are exported for
PKWARE DCL streams outside an archive. `implode` accepts a `dictionarySize` of
`1024`, `2048`, or `4096` bytes (the default). Its `ascii` option selects
Huffman-coded literals; when omitted, mopaq tries both modes and uses the
smaller result.

## TypeScript

The library is written in TypeScript and published as genuine dual ESM and
CommonJS, with separate declarations for each, so `import` and `require` both
resolve correct types. CI runs [publint](https://publint.dev) and
[are-the-types-wrong](https://arethetypeswrong.github.io) on every commit, which
catches the packaging mistakes that usually only surface after release.

```typescript
import type {
  CompressionMethod,
  CreatorOptions,
  FileInfo,
  FileOptions,
  ImplodeOptions,
  MpqErrorKind,
} from 'mopaq';
```

Public signatures use `Uint8Array`, never `Buffer`. A Node `Buffer` is already a
`Uint8Array` so it works unchanged, and browser consumers don't need
`@types/node` to typecheck.

## Runtime notes

Node 18 or newer. Browsers, Deno and Bun work from the same build, as do edge
runtimes, where the async methods fall back to on-thread work if workers aren't
available.

The single dependency is [fflate](https://github.com/101arrowz/fflate), which
provides zlib without pulling in Node's. The library itself is about 13 kB
gzipped.

## Development

```bash
npm install
npm test          # runs against the TypeScript sources, no build needed
npm run typecheck
npm run build     # ESM, CJS and declarations into dist/
npm run verify    # everything above, plus publint and attw
```

Releases go out by pushing a `v*` tag. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the layout and the constraint that keeps the library free of Node built-ins.

## License

[MIT](./LICENSE)
