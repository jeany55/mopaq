/**
 * MPQ crypto utilities: crypto table generation, hashing, encryption/decryption.
 */
import {
    ASCII_UPPER_LOOKUP_SLASH_SENSITIVE,
    MPQ_HASH_FILE_KEY,
    MPQ_HASH_KEY2_MIX,
} from './consts';

/** The static 1280-element crypto table, generated once at module load. */
export const CRYPTO_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(0x500);
    let seed = 0x00100001;
    for (let i = 0; i < 0x100; i++) {
        for (let j = 0; j < 5; j++) {
            const index = i + j * 0x100;
            seed = (seed * 125 + 3) % 0x002AAAAB;
            const t1 = (seed & 0xFFFF) << 16;
            seed = (seed * 125 + 3) % 0x002AAAAB;
            const t2 = seed & 0xFFFF;
            table[index] = (t1 | t2) >>> 0;
        }
    }
    return table;
})();

/**
 * Compute an MPQ hash of a string.
 * @param source - The raw bytes of the filename
 * @param hashType - One of MPQ_HASH_TABLE_INDEX, MPQ_HASH_NAME_A, MPQ_HASH_NAME_B, MPQ_HASH_FILE_KEY
 */
export function hashString(source: Uint8Array, hashType: number): number {
    let seed1 = 0x7FED7FED;
    let seed2 = 0xEEEEEEEE;
    const table = CRYPTO_TABLE;
    const upperLookup = ASCII_UPPER_LOOKUP_SLASH_SENSITIVE;
    const len = source.length;
    for (let i = 0; i < len; i++) {
        const upper = upperLookup[source[i]];
        seed1 = (table[hashType + upper] ^ ((seed1 + seed2) >>> 0)) >>> 0;
        seed2 = (upper + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
    }
    return seed1 >>> 0;
}

/**
 * Decrypt an MPQ data block in place.
 * Operates on 32-bit words (data length truncated to multiple of 4).
 *
 * Uses Uint32Array for bulk 32-bit access, which is significantly faster than
 * DataView.getUint32/setUint32 in tight loops because the JIT can optimise
 * aligned typed-array element access into single load/store instructions.
 */
export function decryptMpqBlock(data: Uint8Array, key: number): void {
    const words = data.length >>> 2;
    if (words === 0) return;

    // Fast path: when the data is already 4-byte aligned we can overlay a
    // Uint32Array directly (zero-copy). The common case in MPQ processing is
    // that buffers come from `new Uint8Array(...)` which is always aligned.
    const aligned =
        (data.byteOffset & 3) === 0;
    const u32 = aligned
        ? new Uint32Array(data.buffer, data.byteOffset, words)
        : new Uint32Array(
              data.buffer.slice(data.byteOffset, data.byteOffset + words * 4),
          );

    let keySec = 0xEEEEEEEE;
    const table = CRYPTO_TABLE;
    const mix = MPQ_HASH_KEY2_MIX;
    for (let i = 0; i < words; i++) {
        keySec = (keySec + table[mix + (key & 0xFF)]) >>> 0;
        const orig = u32[i];
        const decrypted = (orig ^ ((key + keySec) >>> 0)) >>> 0;
        u32[i] = decrypted;
        key = (((~key << 0x15) >>> 0) + 0x11111111 | (key >>> 0x0B)) >>> 0;
        keySec = (decrypted + keySec + ((keySec << 5) >>> 0) + 3) >>> 0;
    }

    // Copy back if we had to slice (unaligned case).
    if (!aligned) {
        data.set(new Uint8Array(u32.buffer), 0);
    }
}

/**
 * Encrypt an MPQ data block in place.
 *
 * Mirror of decryptMpqBlock — see its doc comment for the Uint32Array rationale.
 */
export function encryptMpqBlock(data: Uint8Array, key: number): void {
    const words = data.length >>> 2;
    if (words === 0) return;

    const aligned = (data.byteOffset & 3) === 0;
    const u32 = aligned
        ? new Uint32Array(data.buffer, data.byteOffset, words)
        : new Uint32Array(
              data.buffer.slice(data.byteOffset, data.byteOffset + words * 4),
          );

    let keySec = 0xEEEEEEEE;
    const table = CRYPTO_TABLE;
    const mix = MPQ_HASH_KEY2_MIX;
    for (let i = 0; i < words; i++) {
        keySec = (keySec + table[mix + (key & 0xFF)]) >>> 0;
        const temp = u32[i];
        const encrypted = (temp ^ ((key + keySec) >>> 0)) >>> 0;
        u32[i] = encrypted;
        key = (((~key << 0x15) >>> 0) + 0x11111111 | (key >>> 0x0B)) >>> 0;
        keySec = (temp + keySec + ((keySec << 5) >>> 0) + 3) >>> 0;
    }

    if (!aligned) {
        data.set(new Uint8Array(u32.buffer), 0);
    }
}

/**
 * Get the plain filename from a path (everything after the last \ or /).
 */
export function getPlainName(name: string): string {
    const lastBackslash = name.lastIndexOf('\\');
    const lastSlash = name.lastIndexOf('/');
    const last = Math.max(lastBackslash, lastSlash);
    return last >= 0 ? name.slice(last + 1) : name;
}

/**
 * Convert a string to bytes (Latin-1/ASCII encoding).
 */
export function stringToBytes(str: string): Uint8Array {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i) & 0xFF;
    }
    return bytes;
}

/**
 * Calculate the encryption key for a file.
 */
export function calculateFileKey(
    name: string,
    fileOffset: number,
    fileSize: number,
    adjusted: boolean,
): number {
    const plain = getPlainName(name);
    let key = hashString(stringToBytes(plain), MPQ_HASH_FILE_KEY);
    if (adjusted) {
        key = ((key + fileOffset) ^ fileSize) >>> 0;
    }
    return key;
}
