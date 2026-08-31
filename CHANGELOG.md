# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/jeany55/mopaq/releases/tag/v1.0.0
