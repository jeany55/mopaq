/**
 * MPQ header structures.
 */
import { MpqError } from './error';

export interface FileHeader {
    headerSize: number;
    archiveSize: number;
    formatVersion: number;
    blockSize: number;
    hashTableOffset: number;
    blockTableOffset: number;
    hashTableEntries: number;
    blockTableEntries: number;
}

export interface UserHeader {
    userDataSize: number;
    fileHeaderOffset: number;
}

/**
 * Read the MPQ file header from a buffer at the given offset.
 * Assumes the magic has already been consumed; reads from offset + 4.
 */
export function readFileHeader(data: DataView, offset: number): FileHeader {
    const headerSize = data.getUint32(offset + 4, true);
    const archiveSize = data.getUint32(offset + 8, true);
    const formatVersion = data.getUint16(offset + 12, true);
    const blockSize = data.getUint16(offset + 14, true);
    const hashTableOffset = data.getUint32(offset + 16, true);
    const blockTableOffset = data.getUint32(offset + 20, true);
    const hashTableEntries = data.getUint32(offset + 24, true);
    const blockTableEntries = data.getUint32(offset + 28, true);

    if (formatVersion !== 0) {
        throw new MpqError('UnsupportedVersion', `Format version ${formatVersion} is not supported`);
    }

    return {
        headerSize,
        archiveSize,
        formatVersion,
        blockSize,
        hashTableOffset,
        blockTableOffset,
        hashTableEntries,
        blockTableEntries,
    };
}

/**
 * Read a user data header from a buffer at the given offset.
 */
export function readUserHeader(data: DataView, offset: number): UserHeader {
    return {
        userDataSize: data.getUint32(offset + 4, true),
        fileHeaderOffset: data.getUint32(offset + 8, true),
    };
}

/**
 * Write the MPQ file header to a buffer at the given offset.
 */
export function writeFileHeader(data: DataView, offset: number, header: FileHeader): void {
    data.setUint32(offset + 0, 0x1A51504D, true); // magic
    data.setUint32(offset + 4, header.headerSize, true);
    data.setUint32(offset + 8, header.archiveSize, true);
    data.setUint16(offset + 12, header.formatVersion, true);
    data.setUint16(offset + 14, header.blockSize, true);
    data.setUint32(offset + 16, header.hashTableOffset, true);
    data.setUint32(offset + 20, header.blockTableOffset, true);
    data.setUint32(offset + 24, header.hashTableEntries, true);
    data.setUint32(offset + 28, header.blockTableEntries, true);
}
