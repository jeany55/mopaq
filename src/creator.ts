/**
 * MPQ Archive creator.
 * Builds new MPQ archives from files.
 */
import {
    HEADER_BOUNDARY,
    HEADER_MPQ_SIZE,
    MIN_HASH_TABLE_SIZE,
    MPQ_FILE_COMPRESS,
    MPQ_FILE_ENCRYPTED,
    MPQ_FILE_ADJUST_KEY,
    MPQ_FILE_EXISTS,
} from './consts';
import { writeFileHeader, FileHeader } from './header';
import {
    HashEntry,
    BlockEntry,
    blankHashEntry,
    computeHashKey,
    writeHashTable,
    writeBlockTable,
    sectorCount,
} from './table';
import { calculateFileKey, encryptMpqBlock, decryptMpqBlock } from './crypto';
import { compressSector, compressSectorAsync, type CompressionMethod } from './compression';

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
 * An MPQ archive creator/writer.
 */
export class Creator {
    private files: StagedFile[] = [];
    private sectorSize: number;
    private listfile: boolean;
    private listfileCompress: CompressionMethod;

    /**
     * Create a new archive creator.
     * @param options - Sector size and listfile options, or just the sector size in bytes (default: 65536)
     */
    constructor(options: number | CreatorOptions = {}) {
        const opts = typeof options === 'number' ? { sectorSize: options } : options;
        this.sectorSize = opts.sectorSize ?? DEFAULT_SECTOR_SIZE;
        this.listfile = opts.listfile ?? true;
        this.listfileCompress = opts.listfileCompress ?? 'zlib';
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
     * Write the complete MPQ archive.
     * @returns The archive as a Uint8Array
     */
    write(): Uint8Array {
        const allFiles = this.staged();

        const fileCount = allFiles.length;
        const hashTableSize = nextPowerOf2(fileCount);

        // We'll build the archive in a growable buffer
        // First pass: calculate approximate size, then write
        // Use a large initial buffer and trim at the end
        const maxSize = allFiles.reduce((sum, f) => sum + f.contents.length + 1024, 0)
            + HEADER_MPQ_SIZE + hashTableSize * 16 + fileCount * 16 + HEADER_BOUNDARY;
        const buffer = new Uint8Array(maxSize);
        const view = new DataView(buffer.buffer);

        // Archive starts at offset 0 (aligned to 512 boundary, which 0 satisfies)
        const archiveStart = 0;
        let writePos = archiveStart + HEADER_MPQ_SIZE;

        // Write each file's data
        const blockEntries: BlockEntry[] = [];

        for (const file of allFiles) {
            const fileOffset = writePos - archiveStart;
            const uncompressedSize = file.contents.length;
            let flags = MPQ_FILE_EXISTS;

            if (file.options.compress) flags |= MPQ_FILE_COMPRESS;
            if (file.options.encrypt) flags |= MPQ_FILE_ENCRYPTED;
            if (file.options.adjustKey) flags |= MPQ_FILE_ADJUST_KEY;

            let encKey: number | null = null;
            if (file.options.encrypt) {
                encKey = calculateFileKey(
                    file.name,
                    fileOffset,
                    uncompressedSize,
                    file.options.adjustKey,
                );
            }

            if (file.options.compress) {
                // Compressed file: write SOT + compressed sectors
                const numSectors = sectorCount(uncompressedSize, this.sectorSize);
                const sotEntries = numSectors + 1;
                const sotSize = sotEntries * 4;

                // Reserve space for SOT
                const sotPos = writePos;
                writePos += sotSize;

                const sectorOffsets: number[] = [sotSize]; // First entry points past SOT

                for (let i = 0; i < numSectors; i++) {
                    const sectorStart = i * this.sectorSize;
                    const remaining = uncompressedSize - sectorStart;
                    const sectorLen = Math.min(remaining, this.sectorSize);
                    const rawSector = file.contents.subarray(sectorStart, sectorStart + sectorLen);

                    let sectorData = compressSector(rawSector, file.options.compress || 'zlib');

                    if (encKey !== null) {
                        sectorData = new Uint8Array(sectorData);
                        encryptMpqBlock(sectorData, (encKey + i) >>> 0);
                    }

                    buffer.set(sectorData, writePos);
                    writePos += sectorData.length;
                    sectorOffsets.push(writePos - sotPos);
                }

                // Write SOT
                const sotBuf = new Uint8Array(sotSize);
                const sotView = new DataView(sotBuf.buffer);
                for (let i = 0; i < sotEntries; i++) {
                    sotView.setUint32(i * 4, sectorOffsets[i], true);
                }

                if (encKey !== null) {
                    encryptMpqBlock(sotBuf, (encKey - 1) >>> 0);
                }
                buffer.set(sotBuf, sotPos);

                const compressedSize = writePos - (archiveStart + fileOffset);
                blockEntries.push({
                    filePos: fileOffset,
                    compressedSize,
                    uncompressedSize,
                    flags,
                });
            } else {
                // Uncompressed file
                if (encKey !== null) {
                    const numSectors = sectorCount(uncompressedSize, this.sectorSize);
                    for (let i = 0; i < numSectors; i++) {
                        const sectorStart = i * this.sectorSize;
                        const remaining = uncompressedSize - sectorStart;
                        const sectorLen = Math.min(remaining, this.sectorSize);
                        const sector = new Uint8Array(
                            file.contents.subarray(sectorStart, sectorStart + sectorLen),
                        );
                        encryptMpqBlock(sector, (encKey + i) >>> 0);
                        buffer.set(sector, writePos);
                        writePos += sectorLen;
                    }
                } else {
                    buffer.set(file.contents, writePos);
                    writePos += uncompressedSize;
                }

                blockEntries.push({
                    filePos: fileOffset,
                    compressedSize: uncompressedSize,
                    uncompressedSize,
                    flags,
                });
            }
        }

        // Write hash table
        const hashTableOffset = writePos - archiveStart;
        const hashEntries: HashEntry[] = Array.from({ length: hashTableSize }, () => blankHashEntry());

        for (let i = 0; i < allFiles.length; i++) {
            const key = computeHashKey(allFiles[i].name);
            let idx = key.index & (hashTableSize - 1);
            while (hashEntries[idx].blockIndex !== 0xFFFFFFFF) {
                idx = (idx + 1) % hashTableSize;
            }
            hashEntries[idx] = {
                hashA: key.hashA,
                hashB: key.hashB,
                locale: 0,
                platform: 0,
                blockIndex: i,
            };
        }

        const hashTableData = writeHashTable(hashEntries);
        buffer.set(hashTableData, writePos);
        writePos += hashTableData.length;

        // Write block table
        const blockTableOffset = writePos - archiveStart;
        const blockTableData = writeBlockTable(blockEntries);
        buffer.set(blockTableData, writePos);
        writePos += blockTableData.length;

        const archiveSize = writePos - archiveStart;

        // Write header
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

        // Return trimmed buffer
        return buffer.subarray(0, writePos);
    }

    /**
     * Write the complete MPQ archive (async).
     * Uses non-blocking zlib compression for compressed sectors.
     * @returns The archive as a Uint8Array
     */
    async writeAsync(): Promise<Uint8Array> {
        const allFiles = this.staged();

        const fileCount = allFiles.length;
        const hashTableSize = nextPowerOf2(fileCount);

        const maxSize = allFiles.reduce((sum, f) => sum + f.contents.length + 1024, 0)
            + HEADER_MPQ_SIZE + hashTableSize * 16 + fileCount * 16 + HEADER_BOUNDARY;
        const buffer = new Uint8Array(maxSize);
        const view = new DataView(buffer.buffer);

        const archiveStart = 0;
        let writePos = archiveStart + HEADER_MPQ_SIZE;

        const blockEntries: BlockEntry[] = [];

        for (const file of allFiles) {
            const fileOffset = writePos - archiveStart;
            const uncompressedSize = file.contents.length;
            let flags = MPQ_FILE_EXISTS;

            if (file.options.compress) flags |= MPQ_FILE_COMPRESS;
            if (file.options.encrypt) flags |= MPQ_FILE_ENCRYPTED;
            if (file.options.adjustKey) flags |= MPQ_FILE_ADJUST_KEY;

            let encKey: number | null = null;
            if (file.options.encrypt) {
                encKey = calculateFileKey(
                    file.name,
                    fileOffset,
                    uncompressedSize,
                    file.options.adjustKey,
                );
            }

            if (file.options.compress) {
                const numSectors = sectorCount(uncompressedSize, this.sectorSize);
                const sotEntries = numSectors + 1;
                const sotSize = sotEntries * 4;

                const sotPos = writePos;
                writePos += sotSize;

                const sectorOffsets: number[] = [sotSize];

                for (let i = 0; i < numSectors; i++) {
                    const sectorStart = i * this.sectorSize;
                    const remaining = uncompressedSize - sectorStart;
                    const sectorLen = Math.min(remaining, this.sectorSize);
                    const rawSector = file.contents.subarray(sectorStart, sectorStart + sectorLen);

                    let sectorData = await compressSectorAsync(rawSector, file.options.compress || 'zlib');

                    if (encKey !== null) {
                        sectorData = new Uint8Array(sectorData);
                        encryptMpqBlock(sectorData, (encKey + i) >>> 0);
                    }

                    buffer.set(sectorData, writePos);
                    writePos += sectorData.length;
                    sectorOffsets.push(writePos - sotPos);
                }

                const sotBuf = new Uint8Array(sotSize);
                const sotView = new DataView(sotBuf.buffer);
                for (let i = 0; i < sotEntries; i++) {
                    sotView.setUint32(i * 4, sectorOffsets[i], true);
                }

                if (encKey !== null) {
                    encryptMpqBlock(sotBuf, (encKey - 1) >>> 0);
                }
                buffer.set(sotBuf, sotPos);

                const compressedSize = writePos - (archiveStart + fileOffset);
                blockEntries.push({
                    filePos: fileOffset,
                    compressedSize,
                    uncompressedSize,
                    flags,
                });
            } else {
                if (encKey !== null) {
                    const numSectors = sectorCount(uncompressedSize, this.sectorSize);
                    for (let i = 0; i < numSectors; i++) {
                        const sectorStart = i * this.sectorSize;
                        const remaining = uncompressedSize - sectorStart;
                        const sectorLen = Math.min(remaining, this.sectorSize);
                        const sector = new Uint8Array(
                            file.contents.subarray(sectorStart, sectorStart + sectorLen),
                        );
                        encryptMpqBlock(sector, (encKey + i) >>> 0);
                        buffer.set(sector, writePos);
                        writePos += sectorLen;
                    }
                } else {
                    buffer.set(file.contents, writePos);
                    writePos += uncompressedSize;
                }

                blockEntries.push({
                    filePos: fileOffset,
                    compressedSize: uncompressedSize,
                    uncompressedSize,
                    flags,
                });
            }
        }

        const hashTableOffset = writePos - archiveStart;
        const hashEntries: HashEntry[] = Array.from({ length: hashTableSize }, () => blankHashEntry());

        for (let i = 0; i < allFiles.length; i++) {
            const key = computeHashKey(allFiles[i].name);
            let idx = key.index & (hashTableSize - 1);
            while (hashEntries[idx].blockIndex !== 0xFFFFFFFF) {
                idx = (idx + 1) % hashTableSize;
            }
            hashEntries[idx] = {
                hashA: key.hashA,
                hashB: key.hashB,
                locale: 0,
                platform: 0,
                blockIndex: i,
            };
        }

        const hashTableData = writeHashTable(hashEntries);
        buffer.set(hashTableData, writePos);
        writePos += hashTableData.length;

        const blockTableOffset = writePos - archiveStart;
        const blockTableData = writeBlockTable(blockEntries);
        buffer.set(blockTableData, writePos);
        writePos += blockTableData.length;

        const archiveSize = writePos - archiveStart;

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

        return buffer.subarray(0, writePos);
    }
}
