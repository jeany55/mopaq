# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.3] - 2026-11-11

### Added
- `Archive.open(data, { offset })` (and `openAsync`): the archive's header is at
  `offset` in `data`. An archive inside a larger file can keep its tables *before* its
  header — a mod patcher's exe lays its archive out so, with a hash table position of
  `0xFFFF7FF0` meaning 32,784 bytes before the header — and only the whole file holds
  those bytes, so a caller that sliced the file at the header could not open it.
- `archive.tables`: where the hash and block tables were read in the data, how many
  entries the header gives each, and how many were read.

### Fixed
- Positions are read as the game's storm reads a version 0 archive: the header's
  position plus the stored one, modulo 2^32, for the tables and for every file. Such
  an archive threw `Corrupted: Hash table extends beyond archive`. The rules follow
  StormLib's reading of storm (`SBaseFileTable.cpp`, `ConvertMpqHeaderToFormat4`,
  `FileOffsetFromMpqOffset`, `LoadMpqTable`; MIT): a table whose start lies past the
  end of the data marks a fake header; a table that runs past the end is read as far
  as it goes, the block table cut to the entries that fit and the hash table's
  missing entries left empty (StormLib fills zeros before decrypting; empty slots end
  a lookup cleanly instead).
- A header whose hash or block table would take 256 MB or more is a fake one, as
  StormLib judges a StarCraft map's: refused with `Corrupted` (and passed over by the
  scan), where a cut table would otherwise be given room for every slot it claims.
- The header's own size field and its archive size are not believed: `archive.size`
  (and `end`) is the header's only when the data holds that much from the header on,
  else what it holds. Patchers and protectors write `0xFFFFFFFF` there, and storm
  never reads it.
- Scanning for a header passes over one whose tables lie outside the data and goes
  on, as StormLib does with a fake header; when no other header is found the first
  one's error is thrown.

### Changed
- Of several neutral (locale 0) entries for one name, the *last* in probe order is
  read, as StarCraft 1.16.1's storm.dll reads them (its lookup at `0x15014610`
  returns an entry of the locale asked for at once and otherwise keeps the last
  neutral match). A protector puts a decoy whose bytes can be read but mean nothing
  at the name's home slot and the real entry later in the chain; the first was read
  before. A locale asked for is still taken at its first entry. `members()` orders a
  name's entries as a lookup meets them before choosing.
- `members()` leaves out a block whose position wraps to before the header: a new
  archive cannot lay it at that offset.

## [1.6.2] - 2026-10-28

### Fixed
- Rewriting an archive whose block table points a member past the end of the file —
  a map protector's fake entry, at an offset up to 4 GB — sized the new archive to
  reach it: the file came out padded with zeros to that offset, or `write` and
  `writeAsync` threw a `RangeError` allocating it. `members()` now leaves out a block
  with none of its bytes in the archive, and an empty stored member takes no space.

## [1.6.1] - 2026-10-27

### Fixed
- `write` and `writeAsync` refused an archive whose stored members share bytes —
  two hash entries naming one block, or one block lying inside another, which map
  protectors write — with `InvalidMember: stored member at offset … overlaps
  another`, so such a map could not be rewritten at all. Members of one archive that
  overlap hold the same bytes where they do, and are now written back as they were.
  Members that overlap with different bytes are still refused.

## [1.6.0] - 2026-10-12

### Added
- Sounds can be read. Blizzard's archives store a WAV's samples with IMA ADPCM
  (mono or stereo) and pack the result with an adaptive Huffman coder, and both
  used to throw `UnsupportedCompression`, so the sounds and music of StarCraft
  were out of reach. `readFile`, `readFileAsync` and `files` now return such a
  file as the plain 16-bit PCM WAV the game plays. Checked against an independent
  decoder on every sound in StarCraft's `StarDat.mpq`, `BrooDat.mpq` and
  `patch_rt.mpq` (1,116 files) and the fifteen stereo music tracks of
  `StarCraft.mpq` and `BroodWar.mpq`: the same bytes throughout. The decoders are
  ports of StormLib's (MIT); its notice is in `THIRD-PARTY-NOTICES.md`, which the
  package now carries.

### Changed
- `UnsupportedCompression` is no longer thrown for Huffman or IMA ADPCM. A Huffman
  stream that is cut short, or names a table that does not exist, throws
  `Corrupted`.

## [1.5.2] - 2026-10-01

### Fixed
- An archive written with 512-byte sectors said 1024 in its header, so every
  compressed file in it longer than one sector read back wrong — the first half,
  then zeros. `new Creator({ sectorSize: 512 })` now writes the size it uses.
- `Creator` refuses a `sectorSize` that is not 512 times a power of two with a
  `RangeError`. The header cannot say any other size, and such an archive was
  written with one sector size and read with another.

## [1.5.1] - 2026-10-01

### Fixed
- `writeAsync`, `readFileAsync` and `filesAsync` no longer start a worker per
  sector. fflate's async functions start one for every call, so an archive of 4 KB
  sectors paid for thousands: a 7.4 MB member took 35 s to write and 6 s to read
  through the async API, against a fraction of a second through the sync one.
  Sectors under 512 KB are now handled on the calling thread, which is handed back
  every 12 ms or so; larger ones still go to a worker. The same member now writes
  in 0.16 s and reads in 0.15 s, and the archive written is byte for byte the same.

## [1.5.0] - 2026-09-14

### Fixed
- A name held in several hash slots is read from the right one. eudplib writes a
  StarCraft map's scenario twice — a locale-0 decoy with an empty block in front of
  the real en-US entry — and the reader took the first match, giving an empty file
  or an offset past the archive. `readFile`, `readFileAsync`, `fileInfo` and
  `slotOf` now consider every entry for the name: a readable block over an
  unreadable one, bytes over none, then the locale asked for, the neutral locale,
  and probe order. `members()` lists such a name once, so a rewrite drops the decoy.

### Added
- `ReadOptions` with `locale`, an optional last argument of `readFile`,
  `readFileAsync`, `fileInfo` and `slotOf`, for an archive that holds a file once
  per locale.

## [1.4.0] - 2026-09-04

### Added
- Rewriting an archive without knowing every member's name. `archive.members()`
  lists every member the hash table names — `(listfile)` or not — as stored, with
  its hash slot, block entry and raw bytes; `archive.slotOf(name)` says which one a
  known name is; `archive.hashEntries()` copies the hash table. `new Creator({
  hashTable })` lays the new table out over it and `creator.addStored(member)`
  writes a member back at its original offset and slot without decoding it, which
  keeps a member encrypted with an offset-adjusted key readable. Slots whose files
  are gone are written as *deleted* (`0xFFFFFFFE`), so probe chains hold; the
  reader now probes past deleted slots too.
- `MpqError` kinds `InvalidMember` (a stored member that cannot be carried: wrong
  sector size, no base hash table, overlapping another or the header) and
  `HashTableFull`.

### Changed
- `write` and `writeAsync` share one layout step. Files are compressed first and
  placed after; with no stored members the archive comes out as before.

## [1.3.0] - 2026-09-02

### Added
- Write files compressed with PKWARE DCL ("implode"): `addFile(name, data,
  { compress: 'pkware' })`. It is what StarEdit and Blizzard's own archives use,
  so it is the one compression every StarCraft and Diablo build reads; zlib
  (`compress: true` or `'zlib'`) stays the default. `implode` and `explode` are
  exported for use outside an archive.
- `new Creator({ sectorSize, listfile, listfileCompress })`: the sector size as
  before (a plain number still works), whether a `(listfile)` is written at all,
  and how it is compressed.
- `archive.fileInfo(name)`: block flags, sizes and the compression method of a
  file's first sector without extracting it.

### Fixed
- Files carrying only the old `MPQ_FILE_IMPLODE` flag (a raw PKWARE stream per
  sector, no compression-type byte) were read as stored; they now decompress.

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
