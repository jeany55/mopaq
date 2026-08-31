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
} from './consts';
import { MpqError } from './error';
import { FileHeader, readFileHeader, readUserHeader } from './header';
import {
    HashEntry,
    BlockEntry,
    readHashTable,
    readBlockTable,
    findHashEntry,
    isCompressed,
    isEncrypted,
    isKeyAdjusted,
    sectorCount,
} from './table';
import { calculateFileKey, decryptMpqBlock } from './crypto';
import { decompressSector, decompressSectorAsync } from './compression';

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
    /** Sector size in bytes */
    private sectorSize: number;
    /** Hash table */
    private hashTable: HashEntry[];
    /** Block table */
    private blockTable: BlockEntry[];

    private constructor(
        data: Uint8Array,
        archiveStart: number,
        header: FileHeader,
        sectorSize: number,
        hashTable: HashEntry[],
        blockTable: BlockEntry[],
    ) {
        this.data = data;
        this.archiveStart = archiveStart;
        this.header = header;
        this.sectorSize = sectorSize;
        this.hashTable = hashTable;
        this.blockTable = blockTable;
    }

    /**
     * Open an MPQ archive from a buffer.
     * Scans for the archive header at 512-byte boundaries.
     */
    static open(data: Uint8Array | Buffer): Archive {
        const buf = data instanceof Buffer ? new Uint8Array(data) : data;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        // Scan for MPQ header at 512-byte boundaries
        const maxBoundary = Math.floor(buf.length / HEADER_BOUNDARY);
        let archiveStart = -1;
        let headerOffset = -1;

        for (let i = 0; i <= maxBoundary; i++) {
            const pos = i * HEADER_BOUNDARY;
            if (pos + 4 > buf.length) break;
            const magic = view.getUint32(pos, true);

            if (magic === HEADER_USER_MAGIC) {
                // User data header -> find real header
                if (pos + 12 > buf.length) continue;
                const userHeader = readUserHeader(view, pos);
                const realPos = userHeader.fileHeaderOffset + pos;
                if (realPos + HEADER_MPQ_SIZE > buf.length) continue;
                const realMagic = view.getUint32(realPos, true);
                if (realMagic !== HEADER_MPQ_MAGIC) {
                    throw new MpqError('Corrupted', 'User header points to invalid MPQ header');
                }
                archiveStart = realPos;
                headerOffset = realPos;
                break;
            } else if (magic === HEADER_MPQ_MAGIC) {
                archiveStart = pos;
                headerOffset = pos;
                break;
            }
        }

        if (archiveStart === -1 || headerOffset === -1) {
            throw new MpqError('NoHeader', 'No valid MPQ header found');
        }

        // Parse the file header
        const header = readFileHeader(view, headerOffset);
        const sectorSize = 512 * Math.pow(2, header.blockSize);

        // Read hash table
        const hashTableStart = archiveStart + header.hashTableOffset;
        const hashTableBytes = header.hashTableEntries * HASH_TABLE_ENTRY_SIZE;
        if (hashTableStart + hashTableBytes > buf.length) {
            throw new MpqError('Corrupted', 'Hash table extends beyond archive');
        }
        const hashTableData = buf.subarray(hashTableStart, hashTableStart + hashTableBytes);
        const hashTable = readHashTable(hashTableData, header.hashTableEntries);

        // Read block table
        const blockTableStart = archiveStart + header.blockTableOffset;
        const blockTableBytes = header.blockTableEntries * BLOCK_TABLE_ENTRY_SIZE;
        if (blockTableStart + blockTableBytes > buf.length) {
            throw new MpqError('Corrupted', 'Block table extends beyond archive');
        }
        const blockTableData = buf.subarray(blockTableStart, blockTableStart + blockTableBytes);
        const blockTable = readBlockTable(blockTableData, header.blockTableEntries);

        return new Archive(buf, archiveStart, header, sectorSize, hashTable, blockTable);
    }

    /**
     * Read a file from the archive by name.
     * @param name - The filename (using backslash separators, e.g. "war3map.j")
     * @returns The file contents as a Uint8Array
     */
    readFile(name: string): Uint8Array {
        const hashEntry = findHashEntry(this.hashTable, name);
        if (!hashEntry) {
            throw new MpqError('FileNotFound', `File not found: ${name}`);
        }

        const blockEntry = this.blockTable[hashEntry.blockIndex];
        if (!blockEntry) {
            throw new MpqError('Corrupted', `Invalid block index: ${hashEntry.blockIndex}`);
        }

        const encrypted = isEncrypted(blockEntry.flags);
        const compressed = isCompressed(blockEntry.flags);
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

        const fileDataStart = this.archiveStart + blockEntry.filePos;

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

            const decoded = decompressSector(sector, expectedSize);
            result.set(decoded, outputOffset);
            outputOffset += decoded.length;
        }

        return result;
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
    static async openAsync(data: Uint8Array | Buffer): Promise<Archive> {
        return Archive.open(data);
    }

    /**
     * Read a file from the archive by name (async).
     * Uses non-blocking zlib decompression for compressed sectors.
     * @param name - The filename (using backslash separators, e.g. "war3map.j")
     * @returns The file contents as a Uint8Array
     */
    async readFileAsync(name: string): Promise<Uint8Array> {
        const hashEntry = findHashEntry(this.hashTable, name);
        if (!hashEntry) {
            throw new MpqError('FileNotFound', `File not found: ${name}`);
        }

        const blockEntry = this.blockTable[hashEntry.blockIndex];
        if (!blockEntry) {
            throw new MpqError('Corrupted', `Invalid block index: ${hashEntry.blockIndex}`);
        }

        const encrypted = isEncrypted(blockEntry.flags);
        const compressed = isCompressed(blockEntry.flags);
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

        const fileDataStart = this.archiveStart + blockEntry.filePos;

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

            decompressPromises.push({
                promise: decompressSectorAsync(sector, expectedSize),
                offset: outputOffset,
            });
            outputOffset += expectedSize;
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

    /** Byte offset of the archive start in the input data */
    get start(): number {
        return this.archiveStart;
    }

    /** Byte offset of the archive end in the input data */
    get end(): number {
        return this.archiveStart + this.header.archiveSize;
    }

    /** Archive size as reported by the header */
    get size(): number {
        return this.header.archiveSize;
    }

    /** Get the raw underlying data buffer */
    get rawData(): Uint8Array {
        return this.data;
    }
}
