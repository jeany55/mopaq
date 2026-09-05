/**
 * MPQ Archive creator.
 * Builds new MPQ archives from files.
 */
import {
    HEADER_MPQ_SIZE,
    MIN_HASH_TABLE_SIZE,
    MPQ_FILE_COMPRESS,
    MPQ_FILE_ENCRYPTED,
    MPQ_FILE_ADJUST_KEY,
    MPQ_FILE_EXISTS,
} from './consts';
import { MpqError } from './error';
import { writeFileHeader, FileHeader } from './header';
import {
    HashEntry,
    BlockEntry,
    blankHashEntry,
    deletedHashEntry,
    isBlankHashEntry,
    isFreeHashEntry,
    computeHashKey,
    writeHashTable,
    writeBlockTable,
    sectorCount,
} from './table';
import { calculateFileKey, encryptMpqBlock } from './crypto';
import { compressSector, compressSectorAsync, type CompressionMethod } from './compression';
import type { StoredMember } from './archive';

/**
 * Options for adding a file to an archive.
 */
export interface FileOptions {
    /** Whether to encrypt the file data (default: false) */
    encrypt?: boolean;
    /**
     * Whether to compress the file data (default: false). `true` is zlib; `'pkware'` is
     * PKWARE DCL, what Blizzard's own tools wrote and the one method every StarCraft and
     * Diablo build reads.
     */
    compress?: boolean | CompressionMethod;
    /** Whether to adjust the encryption key by file offset/size (default: false) */
    adjustKey?: boolean;
}

interface StagedFile {
    name: string;
    contents: Uint8Array;
    options: { encrypt: boolean; compress: CompressionMethod | false; adjustKey: boolean };
}

/** A staged file with its sectors produced: everything but its position and its encryption. */
interface PreparedFile {
    file: StagedFile;
    flags: number;
    /** The sector table, unencrypted, or null for an uncompressed file. */
    sot: Uint8Array | null;
    sectors: Uint8Array[];
    /** Bytes the member occupies: the sector table and every sector. */
    size: number;
}

/**
 * Options for a new archive.
 */
export interface CreatorOptions {
    /** Sector size in bytes (default: 65536). Blizzard's StarCraft-era tools wrote 4096. */
    sectorSize?: number;
    /**
     * Whether to write a `(listfile)` naming every file (default: true). Without one the
     * archive's contents can only be found by name; the games never read it.
     */
    listfile?: boolean;
    /** How the `(listfile)` is compressed (default: zlib). */
    listfileCompress?: CompressionMethod;
    /**
     * Lay the new hash table out over this one — `archive.hashEntries()` of the archive
     * being rewritten. The table keeps its size, every slot that named a file and is not
     * reused is marked deleted rather than empty, and members added with `addStored` keep
     * their slots. A lookup probes forward from a name's home slot until it meets the name
     * or an *empty* slot, so this is what keeps a stored member — whose name, and so whose
     * home slot, is not known — findable. Files added by name take free slots as usual.
     */
    hashTable?: readonly HashEntry[];
}

/**
 * The default sector size used for new archives: 65536 bytes (512 * 2^7).
 */
const DEFAULT_SECTOR_SIZE = 0x10000;

/**
 * Compute the block_size exponent from a sector size.
 */
function computeBlockSizeExponent(sectorSize: number): number {
    let s = sectorSize / 512;
    let pow = 1;
    while (s > 2) {
        s = Math.floor(s / 2);
        pow++;
    }
    return pow;
}

/**
 * Compute the smallest power of 2 >= max(MIN_HASH_TABLE_SIZE, n).
 */
function nextPowerOf2(n: number): number {
    n = Math.max(n, MIN_HASH_TABLE_SIZE);
    let v = 1;
    while (v < n) v <<= 1;
    return v;
}

/**
 * Where the members go. Stored members are pinned where they were; everything else is
 * placed first-fit in the gaps they leave and after them, so a rewritten archive stays
 * about the size it was rather than growing by the old scenario every save.
 */
class Layout {
    /** Free ranges, ascending, the last one open-ended. */
    private free: { start: number; end: number }[] = [{ start: HEADER_MPQ_SIZE, end: Infinity }];

    /** Take `[start, start + size)` out of the free space; false when it is not all free. */
    pin(start: number, size: number): boolean {
        const end = start + size;
        const i = this.free.findIndex(r => r.start <= start && end <= r.end);
        if (i < 0) return false;
        const r = this.free[i];
        const pieces = [];
        if (r.start < start) pieces.push({ start: r.start, end: start });
        if (end < r.end) pieces.push({ start: end, end: r.end });
        this.free.splice(i, 1, ...pieces);
        return true;
    }

    /** The first free range that holds `size` bytes, carved from its front. */
    alloc(size: number): number {
        const i = this.free.findIndex(r => r.end - r.start >= size);
        const r = this.free[i];
        const start = r.start;
        if (r.end - r.start === size) this.free.splice(i, 1);
        else r.start += size;
        return start;
    }

    /** Where the tables go: past everything placed. */
    end(): number {
        return this.free[this.free.length - 1].start;
    }
}

/**
 * An MPQ archive creator/writer.
 */
export class Creator {
    private files: StagedFile[] = [];
    private stored: StoredMember[] = [];
    private sectorSize: number;
    private listfile: boolean;
    private listfileCompress: CompressionMethod;
    private baseHashTable: readonly HashEntry[] | null;

    /**
     * Create a new archive creator.
     * @param options - Sector size and listfile options, or just the sector size in bytes (default: 65536)
     */
    constructor(options: number | CreatorOptions = {}) {
        const opts = typeof options === 'number' ? { sectorSize: options } : options;
        this.sectorSize = opts.sectorSize ?? DEFAULT_SECTOR_SIZE;
        this.listfile = opts.listfile ?? true;
        this.listfileCompress = opts.listfileCompress ?? 'zlib';
        this.baseHashTable = opts.hashTable ?? null;
        if (this.baseHashTable) {
            const n = this.baseHashTable.length;
            if (n === 0 || (n & (n - 1)) !== 0) {
                throw new MpqError('InvalidMember', `hashTable must have a power-of-two number of slots, not ${n}`);
            }
        }
    }

    /** The files staged so far, with the `(listfile)` first when one is written. */
    private staged(): StagedFile[] {
        if (!this.listfile) return [...this.files];
        const allNames = this.files.map(f => f.name);
        const listfileContent = new TextEncoder().encode(allNames.join('\r\n'));
        return [
            {
                name: '(listfile)',
                contents: listfileContent,
                options: { encrypt: true, compress: this.listfileCompress, adjustKey: true },
            },
            ...this.files,
        ];
    }

    /**
     * Add a file to the archive.
     * Forward slashes in the name are automatically converted to backslashes.
     * @param name - The filename (e.g. "war3map.j" or "scripts/main.j")
     * @param contents - The file data
     * @param options - Compression/encryption options
     */
    addFile(name: string, contents: Uint8Array, options: FileOptions = {}): void {
        const normalizedName = name.replace(/\//g, '\\');
        this.files.push({
            name: normalizedName,
            contents,
            options: {
                encrypt: options.encrypt ?? false,
                compress: options.compress === true ? 'zlib' : options.compress || false,
                adjustKey: options.adjustKey ?? false,
            },
        });
    }

    /**
     * Carry a member of another archive across as it is stored — `archive.members()` —
     * without decoding it, and so without needing its name: it is written back at the
     * same offset with the same block entry and keeps its hash-table slot, which is what
     * keeps it findable and, when encrypted with an offset-adjusted key, readable.
     *
     * Needs `CreatorOptions.hashTable` (the source archive's `hashEntries()`) and the
     * source's sector size, since a compressed member's sector table is only readable at
     * the size it was written for. `write` refuses a member that overlaps another or the
     * header. The `(listfile)`, when written, names only the files added with `addFile`.
     */
    addStored(member: StoredMember): void {
        if (!this.baseHashTable) {
            throw new MpqError('InvalidMember', "addStored needs CreatorOptions.hashTable: the source archive's hashEntries()");
        }
        if (member.sectorSize !== this.sectorSize) {
            throw new MpqError('InvalidMember', `stored member was written for ${member.sectorSize}-byte sectors; this archive uses ${this.sectorSize}`);
        }
        if (member.slot < 0 || member.slot >= this.baseHashTable.length) {
            throw new MpqError('InvalidMember', `hash slot ${member.slot} is outside a table of ${this.baseHashTable.length}`);
        }
        if (member.block.filePos < HEADER_MPQ_SIZE) {
            throw new MpqError('InvalidMember', `stored member at offset ${member.block.filePos} overlaps the archive header`);
        }
        this.stored.push(member);
    }

    private prepare(file: StagedFile, compress: (data: Uint8Array, method: CompressionMethod) => Uint8Array): PreparedFile {
        let flags = MPQ_FILE_EXISTS;
        if (file.options.compress) flags |= MPQ_FILE_COMPRESS;
        if (file.options.encrypt) flags |= MPQ_FILE_ENCRYPTED;
        if (file.options.adjustKey) flags |= MPQ_FILE_ADJUST_KEY;

        const uncompressedSize = file.contents.length;
        const numSectors = sectorCount(uncompressedSize, this.sectorSize);
        const sectors: Uint8Array[] = [];
        for (let i = 0; i < numSectors; i++) {
            const start = i * this.sectorSize;
            const raw = file.contents.subarray(start, Math.min(start + this.sectorSize, uncompressedSize));
            sectors.push(file.options.compress ? compress(raw, file.options.compress) : raw);
        }

        if (!file.options.compress) {
            return { file, flags, sot: null, sectors, size: uncompressedSize };
        }
        const sotSize = (numSectors + 1) * 4;
        const sot = new Uint8Array(sotSize);
        const view = new DataView(sot.buffer);
        let offset = sotSize;
        view.setUint32(0, offset, true);
        sectors.forEach((s, i) => { offset += s.length; view.setUint32((i + 1) * 4, offset, true); });
        return { file, flags, sot, sectors, size: offset };
    }

    /** Places every member, encrypts what needs it, writes the tables and the header. */
    private assemble(prepared: PreparedFile[]): Uint8Array {
        const archiveStart = 0;
        const layout = new Layout();

        for (const m of this.stored) {
            if (!layout.pin(m.block.filePos, m.data.length)) {
                throw new MpqError('InvalidMember', `stored member at offset ${m.block.filePos} overlaps another`);
            }
        }
        const placed = prepared.map(p => ({ p, pos: layout.alloc(p.size) }));

        // Tables after the last member; the buffer is sized exactly from the layout.
        const hashTableSize = this.baseHashTable ? this.baseHashTable.length : nextPowerOf2(prepared.length);
        const blockCount = this.stored.length + prepared.length;
        const hashTableOffset = layout.end();
        const blockTableOffset = hashTableOffset + hashTableSize * 16;
        const archiveSize = blockTableOffset + blockCount * 16;
        const buffer = new Uint8Array(archiveSize);
        const view = new DataView(buffer.buffer);

        const blockEntries: BlockEntry[] = [];
        for (const m of this.stored) {
            buffer.set(m.data, archiveStart + m.block.filePos);
            blockEntries.push({ ...m.block });
        }
        for (const { p, pos } of placed) {
            const { file } = p;
            const uncompressedSize = file.contents.length;
            const encKey = file.options.encrypt
                ? calculateFileKey(file.name, pos, uncompressedSize, file.options.adjustKey)
                : null;
            let writePos = archiveStart + pos;
            if (p.sot) {
                const sot = encKey === null ? p.sot : new Uint8Array(p.sot);
                if (encKey !== null) encryptMpqBlock(sot, (encKey - 1) >>> 0);
                buffer.set(sot, writePos);
                writePos += sot.length;
            }
            p.sectors.forEach((sector, i) => {
                const data = encKey === null ? sector : new Uint8Array(sector);
                if (encKey !== null) encryptMpqBlock(data, (encKey + i) >>> 0);
                buffer.set(data, writePos);
                writePos += data.length;
            });
            blockEntries.push({ filePos: pos, compressedSize: p.size, uncompressedSize, flags: p.flags });
        }

        // Hash table: the base table's occupancy with its files gone, the stored members
        // at their slots, then the named files probed in from their home slots.
        const hashEntries: HashEntry[] = this.baseHashTable
            ? this.baseHashTable.map(e => (isBlankHashEntry(e) ? blankHashEntry() : deletedHashEntry()))
            : Array.from({ length: hashTableSize }, () => blankHashEntry());
        this.stored.forEach((m, i) => {
            if (!isFreeHashEntry(hashEntries[m.slot])) {
                throw new MpqError('InvalidMember', `two stored members claim hash slot ${m.slot}`);
            }
            hashEntries[m.slot] = { ...m.hash, blockIndex: i };
        });
        prepared.forEach((p, i) => {
            const key = computeHashKey(p.file.name);
            const start = key.index & (hashTableSize - 1);
            let idx = start;
            while (!isFreeHashEntry(hashEntries[idx])) {
                idx = (idx + 1) & (hashTableSize - 1);
                if (idx === start) throw new MpqError('HashTableFull', `no free slot in a hash table of ${hashTableSize} for ${p.file.name}`);
            }
            hashEntries[idx] = {
                hashA: key.hashA,
                hashB: key.hashB,
                locale: 0,
                platform: 0,
                blockIndex: this.stored.length + i,
            };
        });

        buffer.set(writeHashTable(hashEntries), archiveStart + hashTableOffset);
        buffer.set(writeBlockTable(blockEntries), archiveStart + blockTableOffset);

        const header: FileHeader = {
            headerSize: HEADER_MPQ_SIZE,
            archiveSize,
            formatVersion: 0,
            blockSize: computeBlockSizeExponent(this.sectorSize),
            hashTableOffset,
            blockTableOffset,
            hashTableEntries: hashTableSize,
            blockTableEntries: blockEntries.length,
        };
        writeFileHeader(view, archiveStart, header);
        return buffer;
    }

    /**
     * Write the complete MPQ archive.
     * @returns The archive as a Uint8Array
     */
    write(): Uint8Array {
        return this.assemble(this.staged().map(f => this.prepare(f, compressSector)));
    }

    /**
     * Write the complete MPQ archive (async).
     * Uses non-blocking zlib compression for compressed sectors.
     * @returns The archive as a Uint8Array
     */
    async writeAsync(): Promise<Uint8Array> {
        const prepared: PreparedFile[] = [];
        for (const file of this.staged()) {
            // Compress every sector first, off the main thread where the platform allows,
            // then lay the file out exactly as the sync path does.
            const compressed: Uint8Array[] = [];
            if (file.options.compress) {
                const numSectors = sectorCount(file.contents.length, this.sectorSize);
                for (let i = 0; i < numSectors; i++) {
                    const start = i * this.sectorSize;
                    const raw = file.contents.subarray(start, Math.min(start + this.sectorSize, file.contents.length));
                    compressed.push(await compressSectorAsync(raw, file.options.compress));
                }
            }
            let next = 0;
            prepared.push(this.prepare(file, () => compressed[next++]));
        }
        return this.assemble(prepared);
    }
}
