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
    for (let i = 0; i < source.length; i++) {
        const upper = ASCII_UPPER_LOOKUP_SLASH_SENSITIVE[source[i]];
        seed1 = (CRYPTO_TABLE[hashType + upper] ^ ((seed1 + seed2) >>> 0)) >>> 0;
        seed2 = (upper + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
    }
    return seed1 >>> 0;
}

/**
 * Decrypt an MPQ data block in place.
 * Operates on 32-bit words (data length truncated to multiple of 4).
 */
export function decryptMpqBlock(data: Uint8Array, key: number): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const words = Math.floor(data.length / 4);
    let keySec = 0xEEEEEEEE;
    for (let i = 0; i < words; i++) {
        keySec = (keySec + CRYPTO_TABLE[MPQ_HASH_KEY2_MIX + (key & 0xFF)]) >>> 0;
        const orig = view.getUint32(i * 4, true);
        const decrypted = (orig ^ ((key + keySec) >>> 0)) >>> 0;
        view.setUint32(i * 4, decrypted, true);
        key = (((~key << 0x15) >>> 0) + 0x11111111 | (key >>> 0x0B)) >>> 0;
        keySec = (decrypted + keySec + ((keySec << 5) >>> 0) + 3) >>> 0;
    }
}

/**
 * Encrypt an MPQ data block in place.
 */
export function encryptMpqBlock(data: Uint8Array, key: number): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const words = Math.floor(data.length / 4);
    let keySec = 0xEEEEEEEE;
    for (let i = 0; i < words; i++) {
        keySec = (keySec + CRYPTO_TABLE[MPQ_HASH_KEY2_MIX + (key & 0xFF)]) >>> 0;
        const temp = view.getUint32(i * 4, true);
        const encrypted = (temp ^ ((key + keySec) >>> 0)) >>> 0;
        view.setUint32(i * 4, encrypted, true);
        key = (((~key << 0x15) >>> 0) + 0x11111111 | (key >>> 0x0B)) >>> 0;
        keySec = (temp + keySec + ((keySec << 5) >>> 0) + 3) >>> 0;
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
