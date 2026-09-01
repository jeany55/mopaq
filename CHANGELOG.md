# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-01

### Changed

- Improved MPQ hashing, encryption, decryption and table parsing performance by
  using typed-array access and reducing work in hot loops.
- Reduced PKWARE DCL decompression overhead by keeping bit-reader state local
  and using bulk copies for non-overlapping matches.

### Fixed

- Corrected the encrypted-block fast-path alignment check to depend on the
  buffer's byte offset.

## [1.1.0] - 2026-08-31

### Added

- Read files compressed with PKWARE DCL ("implode"), the compression Blizzard
  used for nearly every file in StarCraft- and Diablo-era archives and for the
  `scenario.chk` inside `.scm`/`.scx` maps. Those archives previously threw
  `UnsupportedCompression` on essentially every read; they now open.

  Decompression only. Writing stays zlib, which is smaller and readable
  everywhere, so there is no encoder and no new option on `addFile`.

  The decoder follows Mark Adler's `blast.c` (zlib contrib, public domain):
  the same fixed Huffman tables, inverted-code decoding order and 4 KB window.
  It adds no dependency.

## [1.0.1] - 2026-08-31

### Changed

- Rewrote the README in a plainer voice and documented what the library does
  *not* do: only zlib is implemented, so PKWARE DCL, bzip2, Huffman and IMA
  ADPCM throw `UnsupportedCompression`. PKWARE DCL in particular appears in
  many Warcraft III maps, and the previous README did not mention it.
- `homepage`, `bugs` and `repository` now point at `jeany55/mopaq`, matching
  the package name. npm records these per version, so the 1.0.0 entry on the
  registry keeps the pre-rename URLs.
- Releases publish through npm trusted publishing instead of an access token.

No runtime or API changes. The published code is identical to 1.0.0.

## [1.0.0] - 2026-08-31

### Added

- Read MPQ v1 archives: `Archive.open()`, `archive.readFile()`, `archive.files()`.
- Create MPQ v1 archives: `Creator`, `creator.addFile()`, `creator.write()`.
- Async counterparts for every public method (`openAsync`, `readFileAsync`,
  `filesAsync`, `writeAsync`) backed by non-blocking zlib.
- zlib compression and MPQ encryption (with optional key adjustment).
- First-class TypeScript types, published as dual ESM/CommonJS.
- Universal runtime support: the same build runs in Node.js 18+, browsers,
  Deno, Bun and edge runtimes. Compression uses
  [fflate](https://github.com/101arrowz/fflate) rather than Node's `zlib`, so
  both the sync and async APIs are available everywhere. The async API offloads
  to a worker where one is available and falls back on-thread where it is not.
- `Archive.open()` and `creator.addFile()` accept any `Uint8Array` (a Node
  `Buffer` still works, as it is one); no `Buffer` appears in the public types,
  so browser consumers do not need `@types/node`.
- Decompression failures now surface as `MpqError` with kind `Corrupted`
  instead of leaking the underlying compression library's error.

[1.2.0]: https://github.com/jeany55/mopaq/releases/tag/v1.2.0
[1.1.0]: https://github.com/jeany55/mopaq/releases/tag/v1.1.0
[1.0.1]: https://github.com/jeany55/mopaq/releases/tag/v1.0.1
[1.0.0]: https://github.com/jeany55/mopaq/releases/tag/v1.0.0
