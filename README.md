# mopaq

Read and write MPQ archives in JavaScript and TypeScript.

MPQ (also written MoPaQ) is the archive format Blizzard used for Warcraft III,
StarCraft and Diablo II. In practice you'll want this to pull apart map files
like `.w3x`, `.w3m` and `.scx`, or to build one.

[![npm](https://img.shields.io/npm/v/mopaq.svg)](https://www.npmjs.com/package/mopaq)
[![CI](https://github.com/jeany55/mopaq/actions/workflows/ci.yml/badge.svg)](https://github.com/jeany55/mopaq/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mopaq.svg)](./LICENSE)

The source contains no Node built-ins, so the same build runs in Node 18+,
browsers, Deno and Bun. Bundlers need no configuration and no polyfills. Every
method has a Promise-returning counterpart, and the package ships TypeScript
declarations for both ESM and CommonJS.

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
stores name hashes rather than the names themselves.

## Writing an archive

```typescript
import { Creator } from 'mopaq';
import { writeFileSync } from 'node:fs';

const creator = new Creator();

creator.addFile('readme.txt', new TextEncoder().encode('hello'));
creator.addFile('data/config.ini', configBytes, { compress: true });
creator.addFile('scripts/main.j', scriptBytes, {
  compress: true,
  encrypt: true,
  adjustKey: true,
});

writeFileSync('output.mpq', creator.write());
```

Nothing is written until you call `write()`. A `(listfile)` is generated from
the names you staged, so archives you produce here list their own contents in
other MPQ tools. Forward slashes in names are converted to the backslashes MPQ
expects.

## Promises

Every method has an async counterpart. There are no callbacks in the package and
nothing to `promisify`.

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

The ones that compress or decompress (`readFileAsync`, `writeAsync`, and
`filesAsync`, which reads the `(listfile)`) hand that work to a worker:
`worker_threads` in Node, a Web Worker in the browser. If workers aren't
available, which happens under a strict `worker-src` CSP, they quietly run
on-thread instead of failing.

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

Use the async methods on the main thread. A large archive will visibly freeze
the page otherwise, since compression is the expensive part and the sync methods
do it inline. If you're already inside your own worker, use the sync methods.

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
| `Corrupted` | Data didn't decode, including zlib stream failures |
| `UnsupportedVersion` | An MPQ version this library doesn't read |
| `UnsupportedCompression` | A compression method this library doesn't implement |
| `IoError` | Reserved; nothing throws this today |

## What's supported

Read and write MPQ version 1, the format used by Warcraft III and earlier games.
Later versions throw `UnsupportedVersion`.

Reading handles zlib and PKWARE DCL. Writing is always zlib. MPQ allows several
other methods, and a file using one of those throws `UnsupportedCompression`
naming which one:

| Method | Status |
|--------|--------|
| zlib | Read and write |
| PKWARE DCL | Read |
| bzip2 | Not implemented |
| Huffman | Not implemented |
| IMA ADPCM (mono and stereo) | Not implemented |

PKWARE DCL matters more than its share of the format suggests: it is what
StarCraft, Diablo and many Warcraft III maps use for nearly every file, so
archives from those games are unreadable without it. There is no reason to
*write* it — zlib is both smaller and readable everywhere — so the encoder is
not implemented.

The remaining three are audio and text codecs used inside game data archives.
If you hit one, the error tells you which method the file wanted.

Encryption is fully supported in both directions, including the key adjustment
some archives apply.

## API

### Archive

| | |
|---|---|
| `Archive.open(data: Uint8Array): Archive` | Open an archive from bytes |
| `Archive.openAsync(data: Uint8Array): Promise<Archive>` | Same, Promise-returning |
| `archive.readFile(name: string): Uint8Array` | Read one file |
| `archive.readFileAsync(name: string): Promise<Uint8Array>` | Same, decompresses off-thread |
| `archive.files(): string[] \| null` | Names from `(listfile)`, or `null` if absent |
| `archive.filesAsync(): Promise<string[] \| null>` | Same, off-thread |
| `archive.start` / `archive.end` / `archive.size` | Byte offsets and size |
| `archive.fileInfo(name): FileInfo \| null` | Flags, sizes and the compression method of a file, without extracting it |

### Creator

| | |
|---|---|
| `new Creator(options?)` | `{ sectorSize?, listfile?, listfileCompress? }`, or just the sector size; see below |
| `creator.addFile(name, data, options?)` | Stage a file |
| `creator.write(): Uint8Array` | Build the archive |
| `creator.writeAsync(): Promise<Uint8Array>` | Same, compresses off-thread |

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

`implode(data, { dictionarySize?, ascii? })` and `explode(data, uncompressedSize)` are
exported too, for PKWARE DCL streams outside an archive.

## TypeScript

The library is written in TypeScript and published as genuine dual ESM and
CommonJS, with separate declarations for each, so `import` and `require` both
resolve correct types. CI runs [publint](https://publint.dev) and
[are-the-types-wrong](https://arethetypeswrong.github.io) on every commit, which
catches the packaging mistakes that usually only surface after release.

```typescript
import type { FileOptions, MpqErrorKind, FileHeader } from 'mopaq';
```

Public signatures use `Uint8Array`, never `Buffer`. A Node `Buffer` is already a
`Uint8Array` so it works unchanged, and browser consumers don't need
`@types/node` to typecheck.

## Runtime notes

Node 18 or newer. Browsers, Deno and Bun work from the same build, as do edge
runtimes, where the async methods fall back to on-thread work if workers aren't
available.

The single dependency is [fflate](https://github.com/101arrowz/fflate), which
provides zlib without pulling in Node's. The library itself is about 7.5 kB
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
