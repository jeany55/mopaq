/**
 * MPQ hash table and block table structures.
 */
import {
    HASH_TABLE_ENTRY_SIZE,
    BLOCK_TABLE_ENTRY_SIZE,
    HASH_TABLE_EMPTY_ENTRY,
    HASH_TABLE_DELETED_ENTRY,
    HASH_TABLE_KEY,
    BLOCK_TABLE_KEY,
    MPQ_HASH_TABLE_INDEX,
    MPQ_HASH_NAME_A,
    MPQ_HASH_NAME_B,
    MPQ_FILE_IMPLODE,
    MPQ_FILE_COMPRESS,
    MPQ_FILE_ENCRYPTED,
    MPQ_FILE_ADJUST_KEY,
    MPQ_FILE_EXISTS,
} from './consts';
import { hashString, decryptMpqBlock, encryptMpqBlock, stringToBytes } from './crypto';

export interface HashEntry {
    hashA: number;
    hashB: number;
    locale: number;
    platform: number;
    blockIndex: number;
}

export interface BlockEntry {
    filePos: number;
    compressedSize: number;
    uncompressedSize: number;
    flags: number;
}

/**
 * Create a blank (empty) hash entry.
 */
export function blankHashEntry(): HashEntry {
    return {
        hashA: 0xFFFFFFFF,
        hashB: 0xFFFFFFFF,
        locale: 0xFFFF,
        platform: 0x00FF,
        blockIndex: HASH_TABLE_EMPTY_ENTRY,
    };
}

/**
 * Check if a hash entry is blank/empty.
 */
export function isBlankHashEntry(entry: HashEntry): boolean {
    return entry.blockIndex === HASH_TABLE_EMPTY_ENTRY;
}

/**
 * Hash key components for a filename.
 */
export interface HashKey {
    index: number;
    hashA: number;
    hashB: number;
}

/**
 * Compute the hash key components for a filename.
 */
export function computeHashKey(name: string): HashKey {
    const bytes = stringToBytes(name);
    return {
        index: hashString(bytes, MPQ_HASH_TABLE_INDEX),
        hashA: hashString(bytes, MPQ_HASH_NAME_A),
        hashB: hashString(bytes, MPQ_HASH_NAME_B),
    };
}

/**
 * Find a file entry in the hash table.
 */
export function findHashEntry(hashTable: HashEntry[], name: string): HashEntry | null {
    const slot = findHashSlot(hashTable, name);
    return slot < 0 ? null : hashTable[slot];
}

/**
 * The hash-table slot holding `name`, or -1. The search starts at the name's home slot and
 * probes forward until it meets the name or an empty slot; a deleted slot is probed past.
 */
export function findHashSlot(hashTable: HashEntry[], name: string): number {
    const mask = hashTable.length - 1;
    const key = computeHashKey(name);
    const startIdx = key.index & mask;
    let idx = startIdx;
    do {
        const e = hashTable[idx];
        if (e.blockIndex === HASH_TABLE_EMPTY_ENTRY) return -1;
        if (e.blockIndex !== HASH_TABLE_DELETED_ENTRY && e.hashA === key.hashA && e.hashB === key.hashB) return idx;
        idx = (idx + 1) & mask;
    } while (idx !== startIdx);
    return -1;
}

/** A slot whose file was removed: lookups probe past it, so the chains through it hold. */
export function deletedHashEntry(): HashEntry {
    return { ...blankHashEntry(), blockIndex: HASH_TABLE_DELETED_ENTRY };
}

/** True when a slot names no file — empty or deleted — and may take a new one. */
export function isFreeHashEntry(entry: HashEntry): boolean {
    return entry.blockIndex === HASH_TABLE_EMPTY_ENTRY || entry.blockIndex === HASH_TABLE_DELETED_ENTRY;
}

/**
 * Read the hash table from raw encrypted bytes.
 */
export function readHashTable(data: Uint8Array, count: number): HashEntry[] {
    const decrypted = new Uint8Array(data);
    decryptMpqBlock(decrypted, HASH_TABLE_KEY);

    // Use Uint32Array + Uint16Array overlays for faster bulk access.
    const u32 = new Uint32Array(decrypted.buffer, decrypted.byteOffset, count * 4);
    const u16 = new Uint16Array(decrypted.buffer, decrypted.byteOffset, count * 8);

    const entries: HashEntry[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const w = i * 4;   // Uint32 word index
        const h = i * 8;   // Uint16 half-word index
        entries[i] = {
            hashA: u32[w],
            hashB: u32[w + 1],
            locale: u16[h + 4],
            platform: u16[h + 5],
            blockIndex: u32[w + 3],
        };
    }
    return entries;
}

/**
 * Write the hash table to encrypted bytes.
 */
export function writeHashTable(entries: HashEntry[]): Uint8Array {
    const buf = new Uint8Array(entries.length * HASH_TABLE_ENTRY_SIZE);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < entries.length; i++) {
        const offset = i * HASH_TABLE_ENTRY_SIZE;
        const e = entries[i];
        view.setUint32(offset, e.hashA, true);
        view.setUint32(offset + 4, e.hashB, true);
        view.setUint16(offset + 8, e.locale, true);
        view.setUint16(offset + 10, e.platform, true);
        view.setUint32(offset + 12, e.blockIndex, true);
    }
    encryptMpqBlock(buf, HASH_TABLE_KEY);
    return buf;
}

/**
 * Read the block table from raw encrypted bytes.
 */
export function readBlockTable(data: Uint8Array, count: number): BlockEntry[] {
    const decrypted = new Uint8Array(data);
    decryptMpqBlock(decrypted, BLOCK_TABLE_KEY);

    const u32 = new Uint32Array(decrypted.buffer, decrypted.byteOffset, count * 4);

    const entries: BlockEntry[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const w = i * 4;
        entries[i] = {
            filePos: u32[w],
            compressedSize: u32[w + 1],
            uncompressedSize: u32[w + 2],
            flags: u32[w + 3],
        };
    }
    return entries;
}

/**
 * Write the block table to encrypted bytes.
 */
export function writeBlockTable(entries: BlockEntry[]): Uint8Array {
    const buf = new Uint8Array(entries.length * BLOCK_TABLE_ENTRY_SIZE);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < entries.length; i++) {
        const offset = i * BLOCK_TABLE_ENTRY_SIZE;
        const e = entries[i];
        view.setUint32(offset, e.filePos, true);
        view.setUint32(offset + 4, e.compressedSize, true);
        view.setUint32(offset + 8, e.uncompressedSize, true);
        view.setUint32(offset + 12, e.flags, true);
    }
    encryptMpqBlock(buf, BLOCK_TABLE_KEY);
    return buf;
}

// Block entry flag helpers
export function isImploded(flags: number): boolean {
    return (flags & MPQ_FILE_IMPLODE) !== 0;
}

export function isCompressed(flags: number): boolean {
    return (flags & MPQ_FILE_COMPRESS) !== 0;
}

export function isEncrypted(flags: number): boolean {
    return (flags & MPQ_FILE_ENCRYPTED) !== 0;
}

export function isKeyAdjusted(flags: number): boolean {
    return (flags & MPQ_FILE_ADJUST_KEY) !== 0;
}

/**
 * Compute the number of sectors for a file.
 */
export function sectorCount(uncompressedSize: number, sectorSize: number): number {
    if (uncompressedSize === 0) return 1;
    return Math.floor((uncompressedSize - 1) / sectorSize) + 1;
}
