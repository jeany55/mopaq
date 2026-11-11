/**
 * MPQ Archive reader.
 * Reads and extracts files from MPQ archives.
 */
import {
    HEADER_MPQ_MAGIC,
    HEADER_USER_MAGIC,
    HEADER_BOUNDARY,
    HEADER_MPQ_SIZE,
    HASH_TABLE_ENTRY_SIZE,
    BLOCK_TABLE_ENTRY_SIZE,
    MPQ_FILE_EXISTS,
    HASH_TABLE_EMPTY_ENTRY,
} from './consts';
import { MpqError } from './error';
import { FileHeader, readFileHeader, readUserHeader } from './header';
import {
    HashEntry,
    BlockEntry,
    blankHashEntry,
    readHashTable,
    readBlockTable,
    findHashSlots,
    isFreeHashEntry,
    isCompressed,
    isImploded,
    isEncrypted,
    isKeyAdjusted,
    sectorCount,
} from './table';
import { calculateFileKey, decryptMpqBlock } from './crypto';
import { decompressSector, decompressSectorAsync, explodeSector, pacer } from './compression';
import { COMPRESSION_PKWARE, COMPRESSION_ZLIB, COMPRESSION_BZIP2, COMPRESSION_HUFFMAN } from './consts';

/**
 * What the block table says about one file, plus the compression its first sector uses.
 */
/**
 * Which of a name's hash entries to read when it has more than one. An archive may hold a
 * file once per locale, and some tools write a decoy entry in front of the real one — an
 * empty block, or one pointing outside the archive — for readers that take the first
 * match. Without a locale the neutral entry (locale 0) is preferred; either way an entry
 * whose block is unusable, or empty while another has bytes, loses. Of several neutral
 * entries the *last* in probe order is read, as the game's storm reads them (StarCraft
 * 1.16.1's storm.dll, its lookup at 0x15014610: an entry of the locale asked for is taken at
 * once, a neutral one is remembered and a later neutral one replaces it) — a protector
 * puts a decoy with readable but meaningless bytes at the name's home slot and the real
 * entry after it.
 */
export interface ReadOptions {
    /** The locale wanted, as in the hash entry (0x409 en-US, …); the neutral entry is the fallback. */
    locale?: number;
}

/** How `Archive.open` finds the archive in the bytes it is given. */
export interface OpenOptions {
    /**
     * Where the archive's header (`MPQ\x1A`, or a user-data header `MPQ\x1B` that points to
     * it) is in the data. Without it the header is looked for at 512-byte boundaries.
     *
     * Give it with the *whole* file when the archive sits inside a larger one — a
     * self-executing archive, a patcher's exe — and its tables may lie before its header:
     * positions are relative to the header and wrap at 4 GB, so a hash table position of
     * 0xFFFF7FF0 is 32,784 bytes before it. A slice that starts at the header cannot reach
     * those bytes.
     */
    offset?: number;
}

/** Where `Archive.open` read a table in the data, how many entries the header gives it and how many the data held. */
export interface TableExtent {
    /** Byte offset of the table in the data (which may be before the header). */
    start: number;
    /** Entries the header gives the table. */
    entries: number;
    /** Entries read: fewer when the table runs past the end of the data. */
    read: number;
}

/** The hash table's and the block table's places. */
export interface TableLayout {
    hash: TableExtent;
    block: TableExtent;
}

/** A table this large (as stored) marks a fake header: StormLib's limit for a StarCraft map's (`ConvertMpqHeaderToFormat4`). */
const MAX_TABLE_BYTES = 0x10000000;

/** Messages of a header whose tables lie outside the data: a scan passes it over. */
const TABLE_OUTSIDE = /^(Hash|Block) table extends beyond archive$/;

/**
 * Where the archive header is for a mark at `pos`: `pos` itself for `MPQ\x1A`, the header a
 * user-data header `MPQ\x1B` points to, or null for no mark.
 */
function headerAt(view: DataView, buf: Uint8Array, pos: number): number | null {
    if (pos + 4 > buf.length) return null;
    const magic = view.getUint32(pos, true);
    if (magic === HEADER_MPQ_MAGIC) return pos + HEADER_MPQ_SIZE <= buf.length ? pos : null;
    if (magic !== HEADER_USER_MAGIC || pos + 12 > buf.length) return null;
    const userHeader = readUserHeader(view, pos);
    const realPos = userHeader.fileHeaderOffset + pos;
    if (realPos + HEADER_MPQ_SIZE > buf.length) return null;
    if (view.getUint32(realPos, true) !== HEADER_MPQ_MAGIC) {
        throw new MpqError('Corrupted', 'User header points to invalid MPQ header');
    }
    return realPos;
}

export interface FileInfo {
    /** The name as looked up. */
    name: string;
    /** Raw block flags. */
    flags: number;
    /** Bytes the file occupies in the archive, sector offset table included. */
    compressedSize: number;
    /** Bytes the file decompresses to. */
    uncompressedSize: number;
    compressed: boolean;
    encrypted: boolean;
    keyAdjusted: boolean;
    /**
     * The method the first compressed sector uses: `'pkware'`, `'zlib'`, `'bzip2'`,
     * `'huffman'`, another type byte as a number, `'none'` for a stored file, or `null`
     * when the sector could not be inspected.
     */
    compression: 'none' | 'pkware' | 'zlib' | 'bzip2' | 'huffman' | number | null;
}

/**
 * A member exactly as the archive stores it: the hash-table slot naming it, its block-table
 * entry and the stored bytes verbatim — sector table and all, compressed and encrypted as
 * they are. `Creator.addStored` carries one into a new archive without decoding it.
 *
 * This is the only way to keep a member whose *name* is not known. The `(listfile)` is
 * optional and often removed, and without the name a file can neither be found by a
 * reader nor, when encrypted, decrypted: the key is derived from the name and, with
 * `MPQ_FILE_ADJUST_KEY`, from the file's offset — which is why the copy is written back
 * at the same offset and the same slot.
 */
export interface StoredMember {
    /** Index of the hash-table slot naming this member. */
    slot: number;
    hash: HashEntry;
    block: BlockEntry;
    /**
     * Sector size of the archive the member came from. A compressed member's sector table
     * only makes sense at that size, so the archive it is carried into must use it too.
     */
    sectorSize: number;
    /** `block.compressedSize` bytes from `block.filePos`, as stored; fewer if the archive ends early. */
    data: Uint8Array;
}

/**
 * An MPQ archive reader.
 */
export class Archive {
    /** The raw archive data */
    private data: Uint8Array;
    /** Offset of the archive header within the data */
    private archiveStart: number;
    /** Parsed header */
    private header: FileHeader;
    /** Sector size in bytes, from the header. */
    readonly sectorSize: number;
    /** Hash table */
    private hashTable: HashEntry[];
    /** Block table */
    private blockTable: BlockEntry[];
    /** Where the tables were read from, and how much of them. */
    readonly tables: TableLayout;

    private constructor(
        data: Uint8Array,
        archiveStart: number,
        header: FileHeader,
        sectorSize: number,
        hashTable: HashEntry[],
        blockTable: BlockEntry[],
        tables: TableLayout,
    ) {
        this.data = data;
        this.archiveStart = archiveStart;
        this.header = header;
        this.sectorSize = sectorSize;
        this.hashTable = hashTable;
        this.blockTable = blockTable;
        this.tables = tables;
    }

    /** Where a position the archive stores (relative to its header) is in the data: 32-bit wrapping, as storm adds them. */
    private offsetOf(rel: number): number {
        return (this.archiveStart + rel) % 0x100000000;
    }

    /**
     * Open an MPQ archive from a buffer.
     *
     * Without `options.offset` the header is looked for at 512-byte boundaries from the
     * start, as storm looks for one; a header whose tables lie outside the data is passed
     * over (a protector's fake) and the search goes on. With it, the header must be there.
     *
     * Positions are read as the game's storm reads a version 0 archive: relative to the
     * header in 32-bit arithmetic, so a table (or a file) may lie *before* the header — a
     * map protector's trick, and how some mod patchers lay out their archive. Hand over the
     * whole file and the header's `offset` for such an archive: a slice starting at the
     * header cannot reach what lies before it. See `OpenOptions`.
     *
     * Accepts any `Uint8Array`, including a Node.js `Buffer`.
     */
    static open(data: Uint8Array, options: OpenOptions = {}): Archive {
        const buf = data;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        if (options.offset !== undefined) {
            const at = options.offset;
            if (!Number.isInteger(at) || at < 0 || at + HEADER_MPQ_SIZE > buf.length) {
                throw new MpqError('NoHeader', `No MPQ header at offset ${at}: it is not inside the data`);
            }
            const headerOffset = headerAt(view, buf, at);
            if (headerOffset === null) throw new MpqError('NoHeader', `No MPQ header at offset ${at}`);
            return Archive.at(buf, view, headerOffset);
        }

        // Scan for MPQ header at 512-byte boundaries
        const maxBoundary = Math.floor(buf.length / HEADER_BOUNDARY);
        let fake: MpqError | null = null;
        for (let i = 0; i <= maxBoundary; i++) {
            const pos = i * HEADER_BOUNDARY;
            if (pos + 4 > buf.length) break;
            const headerOffset = headerAt(view, buf, pos);
            if (headerOffset === null) continue;
            try {
                return Archive.at(buf, view, headerOffset);
            } catch (e) {
                // A header whose tables lie outside the data is not the archive (StormLib:
                // ERROR_FAKE_MPQ_HEADER): look on, and say why if nothing else is found.
                if (e instanceof MpqError && e.kind === 'Corrupted' && TABLE_OUTSIDE.test(e.detail ?? '')) {
                    fake ??= e;
                    continue;
                }
                throw e;
            }
        }
        throw fake ?? new MpqError('NoHeader', 'No valid MPQ header found');
    }

    /**
     * The archive whose header is at `archiveStart`. Follows the game's storm for a version 0
     * archive, as StormLib documents it (`SBaseFileTable.cpp`: `ConvertMpqHeaderToFormat4`,
     * `FileOffsetFromMpqOffset`, `LoadMpqTable`):
     *
     * - a table's position and a file's are the header's position plus the stored one,
     *   modulo 2^32;
     * - a table whose start lies past the end of the data means the header is no archive's;
     * - a table that runs past the end is read as far as the data goes: the block table is
     *   cut to the entries that fit, the hash table's missing entries are empty slots;
     * - the header's own size field and its archive size are not believed: a version 0
     *   header is 32 bytes, and the size reported is the header's only where the data holds
     *   that much.
     */
    private static at(buf: Uint8Array, view: DataView, archiveStart: number): Archive {
        const header = readFileHeader(view, archiveStart);
        const sectorSize = 512 * Math.pow(2, header.blockSize);
        const wrap = (rel: number) => (archiveStart + rel) % 0x100000000;

        // Read hash table
        const hashTableStart = wrap(header.hashTableOffset);
        // (A table of 256 MB or more is a fake header's, as StormLib judges a StarCraft map's.)
        if (hashTableStart > buf.length || header.hashTableEntries * HASH_TABLE_ENTRY_SIZE >= MAX_TABLE_BYTES) {
            throw new MpqError('Corrupted', 'Hash table extends beyond archive');
        }
        const hashFits = Math.min(header.hashTableEntries, Math.floor((buf.length - hashTableStart) / HASH_TABLE_ENTRY_SIZE));
        const hashTable = readHashTable(buf.subarray(hashTableStart, hashTableStart + hashFits * HASH_TABLE_ENTRY_SIZE), hashFits);
        // (A lookup masks with the table's stated size: the slots the data does not hold are empty — one shared entry,
        // never written to, so a large cut table costs a reference a slot.)
        if (hashFits < header.hashTableEntries) {
            const empty = Object.freeze(blankHashEntry());
            hashTable.length = header.hashTableEntries;
            hashTable.fill(empty, hashFits);
        }

        // Read block table
        const blockTableStart = wrap(header.blockTableOffset);
        if (blockTableStart > buf.length || header.blockTableEntries * BLOCK_TABLE_ENTRY_SIZE >= MAX_TABLE_BYTES) {
            throw new MpqError('Corrupted', 'Block table extends beyond archive');
        }
        const blockFits = Math.min(header.blockTableEntries, Math.floor((buf.length - blockTableStart) / BLOCK_TABLE_ENTRY_SIZE));
        const blockTable = readBlockTable(buf.subarray(blockTableStart, blockTableStart + blockFits * BLOCK_TABLE_ENTRY_SIZE), blockFits);

        const tables: TableLayout = {
            hash: { start: hashTableStart, entries: header.hashTableEntries, read: hashFits },
            block: { start: blockTableStart, entries: header.blockTableEntries, read: blockFits },
        };
        return new Archive(buf, archiveStart, header, sectorSize, hashTable, blockTable, tables);
    }

    /**
     * Read a file from the archive by name.
     * @param name - The filename (using backslash separators, e.g. "war3map.j")
     * @returns The file contents as a Uint8Array
     */
    readFile(name: string, options?: ReadOptions): Uint8Array {
        const blockEntry = this.blockOf(name, options);

        const encrypted = isEncrypted(blockEntry.flags);
        const imploded = isImploded(blockEntry.flags) && !isCompressed(blockEntry.flags);
        const compressed = isCompressed(blockEntry.flags) || imploded;
        const adjusted = isKeyAdjusted(blockEntry.flags);

        let encKey: number | null = null;
        if (encrypted) {
            encKey = calculateFileKey(
                name,
                blockEntry.filePos,
                blockEntry.uncompressedSize,
                adjusted,
            );
        }

        const fileDataStart = this.offsetOf(blockEntry.filePos);

        if (!compressed) {
            // Uncompressed: read raw sectors
            const rawData = new Uint8Array(
                this.data.subarray(fileDataStart, fileDataStart + blockEntry.uncompressedSize),
            );
            if (encrypted && encKey !== null) {
                const numSectors = sectorCount(blockEntry.uncompressedSize, this.sectorSize);
                const result = new Uint8Array(blockEntry.uncompressedSize);
                let outputOffset = 0;
                for (let i = 0; i < numSectors; i++) {
                    const sectorStart = i * this.sectorSize;
                    const remaining = blockEntry.uncompressedSize - sectorStart;
                    const sectorLen = Math.min(remaining, this.sectorSize);
                    const sector = new Uint8Array(rawData.subarray(sectorStart, sectorStart + sectorLen));
                    decryptMpqBlock(sector, (encKey + i) >>> 0);
                    result.set(sector, outputOffset);
                    outputOffset += sectorLen;
                }
                return result;
            }
            return rawData;
        }

        // Compressed: read sector offset table
        const numSectors = sectorCount(blockEntry.uncompressedSize, this.sectorSize);
        const sotEntries = numSectors + 1;
        const sotBytes = sotEntries * 4;

        const sotData = new Uint8Array(this.data.subarray(fileDataStart, fileDataStart + sotBytes));
        if (encrypted && encKey !== null) {
            decryptMpqBlock(sotData, (encKey - 1) >>> 0);
        }

        const sotView = new DataView(sotData.buffer, sotData.byteOffset, sotData.byteLength);
        const sectorOffsets: number[] = [];
        for (let i = 0; i < sotEntries; i++) {
            sectorOffsets.push(sotView.getUint32(i * 4, true));
        }

        // Read each sector
        const result = new Uint8Array(blockEntry.uncompressedSize);
        let outputOffset = 0;

        for (let i = 0; i < numSectors; i++) {
            const sectorStart = fileDataStart + sectorOffsets[i];
            const sectorEnd = fileDataStart + sectorOffsets[i + 1];
            const sectorLen = sectorEnd - sectorStart;

            let sector = new Uint8Array(this.data.subarray(sectorStart, sectorEnd));

            if (encrypted && encKey !== null) {
                sector = new Uint8Array(sector);
                decryptMpqBlock(sector, (encKey + i) >>> 0);
            }

            // Determine expected uncompressed size for this sector
            const remaining = blockEntry.uncompressedSize - outputOffset;
            const expectedSize = Math.min(remaining, this.sectorSize);

            const decoded = imploded ? explodeSector(sector, expectedSize) : decompressSector(sector, expectedSize);
            result.set(decoded, outputOffset);
            outputOffset += decoded.length;
        }

        return result;
    }

    /**
     * Describe a file without extracting it: its block flags, sizes and the compression
     * method of its first sector (read and decrypted just far enough to see the type byte).
     * @returns The description, or null when the archive has no such file
     */
    fileInfo(name: string, options?: ReadOptions): FileInfo | null {
        const slot = this.slotOf(name, options);
        if (slot === null) return null;
        const blockEntry = this.blockTable[this.hashTable[slot].blockIndex];
        if (!blockEntry) return null;
        const flags = blockEntry.flags;
        const imploded = isImploded(flags) && !isCompressed(flags);
        const compressed = isCompressed(flags) || imploded;
        const encrypted = isEncrypted(flags);
        const info: FileInfo = {
            name,
            flags,
            compressedSize: blockEntry.compressedSize,
            uncompressedSize: blockEntry.uncompressedSize,
            compressed,
            encrypted,
            keyAdjusted: isKeyAdjusted(flags),
            compression: compressed ? null : 'none',
        };
        if (!compressed || blockEntry.uncompressedSize === 0) return info;
        try {
            const fileDataStart = this.offsetOf(blockEntry.filePos);
            const numSectors = sectorCount(blockEntry.uncompressedSize, this.sectorSize);
            const sotBytes = (numSectors + 1) * 4;
            const sotData = new Uint8Array(this.data.subarray(fileDataStart, fileDataStart + sotBytes));
            const encKey = encrypted
                ? calculateFileKey(name, blockEntry.filePos, blockEntry.uncompressedSize, isKeyAdjusted(flags))
                : null;
            if (encKey !== null) decryptMpqBlock(sotData, (encKey - 1) >>> 0);
            const sotView = new DataView(sotData.buffer, sotData.byteOffset, sotData.byteLength);
            const start = fileDataStart + sotView.getUint32(0, true);
            const end = fileDataStart + sotView.getUint32(4, true);
            const sectorLen = end - start;
            const expected = Math.min(blockEntry.uncompressedSize, this.sectorSize);
            if (sectorLen >= expected) {
                info.compression = 'none';
            } else if (imploded) {
                info.compression = 'pkware';
            } else {
                // Only the first four bytes need decrypting to read the type byte.
                const head = new Uint8Array(this.data.subarray(start, start + 4));
                if (encKey !== null) decryptMpqBlock(head, encKey >>> 0);
                const type = head[0];
                info.compression = type === COMPRESSION_PKWARE ? 'pkware'
                    : type === COMPRESSION_ZLIB ? 'zlib'
                    : type === COMPRESSION_BZIP2 ? 'bzip2'
                    : type === COMPRESSION_HUFFMAN ? 'huffman'
                    : type;
            }
        } catch {
            info.compression = null;
        }
        return info;
    }

    /**
     * List all files in the archive by reading the (listfile).
     * @returns Array of filenames, or null if (listfile) is not present
     */
    files(): string[] | null {
        try {
            const listData = this.readFile('(listfile)');
            const text = new TextDecoder('utf-8').decode(listData);
            return text
                .split(/\r?\n|\r/)
                .map(s => s.trim())
                .filter(s => s.length > 0);
        } catch (e) {
            if (e instanceof MpqError && e.kind === 'FileNotFound') {
                return null;
            }
            throw e;
        }
    }

    /**
     * Open an MPQ archive from a buffer (async).
     * Functionally identical to `open()` since parsing headers/tables is CPU-bound,
     * but provided for API consistency in async workflows.
     */
    static async openAsync(data: Uint8Array, options?: OpenOptions): Promise<Archive> {
        return Archive.open(data, options);
    }

    /**
     * Read a file from the archive by name (async).
     * Uses non-blocking zlib decompression for compressed sectors.
     * @param name - The filename (using backslash separators, e.g. "war3map.j")
     * @returns The file contents as a Uint8Array
     */
    async readFileAsync(name: string, options?: ReadOptions): Promise<Uint8Array> {
        const blockEntry = this.blockOf(name, options);

        const encrypted = isEncrypted(blockEntry.flags);
        const imploded = isImploded(blockEntry.flags) && !isCompressed(blockEntry.flags);
        const compressed = isCompressed(blockEntry.flags) || imploded;
        const adjusted = isKeyAdjusted(blockEntry.flags);

        let encKey: number | null = null;
        if (encrypted) {
            encKey = calculateFileKey(
                name,
                blockEntry.filePos,
                blockEntry.uncompressedSize,
                adjusted,
            );
        }

        const fileDataStart = this.offsetOf(blockEntry.filePos);

        if (!compressed) {
            const rawData = new Uint8Array(
                this.data.subarray(fileDataStart, fileDataStart + blockEntry.uncompressedSize),
            );
            if (encrypted && encKey !== null) {
                const numSectors = sectorCount(blockEntry.uncompressedSize, this.sectorSize);
                const result = new Uint8Array(blockEntry.uncompressedSize);
                let outputOffset = 0;
                for (let i = 0; i < numSectors; i++) {
                    const sectorStart = i * this.sectorSize;
                    const remaining = blockEntry.uncompressedSize - sectorStart;
                    const sectorLen = Math.min(remaining, this.sectorSize);
                    const sector = new Uint8Array(rawData.subarray(sectorStart, sectorStart + sectorLen));
                    decryptMpqBlock(sector, (encKey + i) >>> 0);
                    result.set(sector, outputOffset);
                    outputOffset += sectorLen;
                }
                return result;
            }
            return rawData;
        }

        // Compressed: read sector offset table
        const numSectors = sectorCount(blockEntry.uncompressedSize, this.sectorSize);
        const sotEntries = numSectors + 1;
        const sotBytes = sotEntries * 4;

        const sotData = new Uint8Array(this.data.subarray(fileDataStart, fileDataStart + sotBytes));
        if (encrypted && encKey !== null) {
            decryptMpqBlock(sotData, (encKey - 1) >>> 0);
        }

        const sotView = new DataView(sotData.buffer, sotData.byteOffset, sotData.byteLength);
        const sectorOffsets: number[] = [];
        for (let i = 0; i < sotEntries; i++) {
            sectorOffsets.push(sotView.getUint32(i * 4, true));
        }

        // Read each sector (decompress concurrently)
        const result = new Uint8Array(blockEntry.uncompressedSize);
        let outputOffset = 0;

        const decompressPromises: Array<{ promise: Promise<Uint8Array>; offset: number; }> = [];
        const pause = pacer();

        for (let i = 0; i < numSectors; i++) {
            const sectorStart = fileDataStart + sectorOffsets[i];
            const sectorEnd = fileDataStart + sectorOffsets[i + 1];

            let sector = new Uint8Array(this.data.subarray(sectorStart, sectorEnd));

            if (encrypted && encKey !== null) {
                sector = new Uint8Array(sector);
                decryptMpqBlock(sector, (encKey + i) >>> 0);
            }

            const remaining = blockEntry.uncompressedSize - outputOffset;
            const expectedSize = Math.min(remaining, this.sectorSize);

            const promise = imploded ? Promise.resolve(explodeSector(sector, expectedSize)) : decompressSectorAsync(sector, expectedSize);
            // The loop may hand the thread back before `Promise.all` below is listening; a
            // sector that failed by then must not count as a rejection nobody handled.
            promise.catch(() => {});
            decompressPromises.push({ promise, offset: outputOffset });
            outputOffset += expectedSize;
            // A small sector was decoded on this thread inside the call above.
            await pause();
        }

        const decompressed = await Promise.all(decompressPromises.map(p => p.promise));
        for (let i = 0; i < decompressed.length; i++) {
            result.set(decompressed[i], decompressPromises[i].offset);
        }

        return result;
    }

    /**
     * List all files in the archive by reading the (listfile) (async).
     * @returns Array of filenames, or null if (listfile) is not present
     */
    async filesAsync(): Promise<string[] | null> {
        try {
            const listData = await this.readFileAsync('(listfile)');
            const text = new TextDecoder('utf-8').decode(listData);
            return text
                .split(/\r?\n|\r/)
                .map(s => s.trim())
                .filter(s => s.length > 0);
        } catch (e) {
            if (e instanceof MpqError && e.kind === 'FileNotFound') {
                return null;
            }
            throw e;
        }
    }

    /**
     * Every member the hash table names, whether or not the `(listfile)` does — each as
     * stored, for `Creator.addStored`. A slot pointing at no block, or at one without the
     * exists flag, is not a member; of several slots for one name only the one `readFile`
     * reads is, so a decoy entry is not carried into a rewrite; nor is a block whose bytes lie
     * wholly past the end of the archive. Names are not part of the answer: `slotOf(name)` says
     * which of these a name you know belongs to.
     */
    members(): StoredMember[] {
        const out: StoredMember[] = [];
        // A name in several slots is one member, the one `readFile` reads; a decoy is not carried.
        const twins = new Map<string, number[]>();
        this.hashTable.forEach((hash, slot) => {
            if (isFreeHashEntry(hash)) return;
            const key = `${hash.hashA}:${hash.hashB}`;
            twins.set(key, [...(twins.get(key) ?? []), slot]);
        });
        this.hashTable.forEach((hash, slot) => {
            if (isFreeHashEntry(hash)) return;
            const same = twins.get(`${hash.hashA}:${hash.hashB}`)!;
            if (same.length > 1 && this.choose(this.probeOrder(same)) !== slot) return;
            const block = this.blockTable[hash.blockIndex];
            if (!block || (block.flags & MPQ_FILE_EXISTS) === 0) return;
            const start = this.archiveStart + block.filePos;
            // A block with none of its bytes in the archive has nothing to carry, and its
            // offset — a protector's, anywhere up to 4 GB — would size the rewrite. Nor has
            // one whose position wraps to before the header: a new archive cannot lay it
            // at that offset.
            if (start >= 0x100000000 || start > this.data.length || (start === this.data.length && block.compressedSize > 0)) return;
            const end = Math.min(start + block.compressedSize, this.data.length);
            out.push({
                slot,
                hash: { ...hash },
                block: { ...block },
                sectorSize: this.sectorSize,
                data: this.data.subarray(start, Math.max(start, end)),
            });
        });
        return out;
    }

    /**
     * The hash-table slot holding `name`, or null when the archive has no such file. With
     * several entries for the name, the one `readFile` would read (see `ReadOptions`).
     */
    slotOf(name: string, options?: ReadOptions): number | null {
        const slots = findHashSlots(this.hashTable, name);
        return slots.length ? this.choose(slots, options?.locale) : null;
    }

    /** The block `readFile` reads for `name`, or the error it throws. */
    private blockOf(name: string, options?: ReadOptions): BlockEntry {
        const slot = this.slotOf(name, options);
        if (slot === null) throw new MpqError('FileNotFound', `File not found: ${name}`);
        const blockIndex = this.hashTable[slot].blockIndex;
        const blockEntry = this.blockTable[blockIndex];
        if (!blockEntry) throw new MpqError('Corrupted', `Invalid block index: ${blockIndex}`);
        return blockEntry;
    }

    /** Whether a hash entry's block can be read at all: present, marked existing, inside the data. */
    private readable(hash: HashEntry): boolean {
        const block = this.blockTable[hash.blockIndex];
        if (!block || (block.flags & MPQ_FILE_EXISTS) === 0) return false;
        const start = this.offsetOf(block.filePos);
        const stored = isCompressed(block.flags) || isImploded(block.flags) ? block.compressedSize : block.uncompressedSize;
        return start + stored <= this.data.length;
    }

    /**
     * Which of several slots for one name to read: a readable block over an unreadable
     * one, a block with bytes over an empty one, the locale asked for (the first in probe
     * order), the neutral locale (the last in probe order, as storm takes it), then the
     * first in probe order.
     */
    private choose(slots: number[], locale?: number): number {
        const readable = slots.filter(s => this.readable(this.hashTable[s]));
        if (readable.length === 0) return slots[0];
        const withBytes = readable.filter(s => this.blockTable[this.hashTable[s].blockIndex].uncompressedSize > 0);
        const pool = withBytes.length ? withBytes : readable;
        const rank = (s: number) => {
            const l = this.hashTable[s].locale;
            return (locale !== undefined && l === locale ? 0 : l === 0 ? 1 : 2);
        };
        return pool.reduce((best, s) => {
            const r = rank(s), b = rank(best);
            return r < b || (r === 1 && b === 1) ? s : best;
        }, pool[0]);
    }

    /**
     * Slots of one name in the order a lookup meets them. The name is not known, so neither
     * is its home slot; but a lookup runs from the home through occupied slots only, so all of
     * them lie in one run of occupied slots, met from the run's first slot on. A table with no
     * empty slot has no run's start to go by: table order.
     */
    private probeOrder(slots: number[]): number[] {
        const n = this.hashTable.length;
        let start = slots[0];
        for (let i = 0; i < n; i++) {
            const prev = (start - 1 + n) % n;
            if (this.hashTable[prev].blockIndex === HASH_TABLE_EMPTY_ENTRY) break;
            start = prev;
            if (i === n - 1) start = 0;
        }
        return [...slots].sort((a, b) => ((a - start + n) % n) - ((b - start + n) % n));
    }

    /** A copy of the hash table as read — what `CreatorOptions.hashTable` takes to lay a new archive out over this one. */
    hashEntries(): HashEntry[] {
        return this.hashTable.map(e => ({ ...e }));
    }

    /** Byte offset of the archive start in the input data */
    get start(): number {
        return this.archiveStart;
    }

    /** Byte offset of the archive end in the input data: `start + size`. */
    get end(): number {
        return this.archiveStart + this.size;
    }

    /**
     * Archive size as reported by the header — or, when the header says more than the data
     * holds from the header on, what it holds. The game's storm never reads this field, and
     * protectors and patchers write 0xFFFFFFFF there.
     */
    get size(): number {
        const held = this.data.length - this.archiveStart;
        return this.header.archiveSize <= held ? this.header.archiveSize : held;
    }

    /** Get the raw underlying data buffer */
    get rawData(): Uint8Array {
        return this.data;
    }
}
