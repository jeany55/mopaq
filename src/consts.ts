/**
 * MPQ format constants.
 */

/** MPQ archive header magic: "MPQ\x1A" */
export const HEADER_MPQ_MAGIC = 0x1A51504D;

/** MPQ user data header magic: "MPQ\x1B" */
export const HEADER_USER_MAGIC = 0x1B51504D;

/** Headers are always aligned to 512-byte boundaries */
export const HEADER_BOUNDARY = 512;

/** Size of the MPQ v1 header in bytes */
export const HEADER_MPQ_SIZE = 32;

/** Minimum number of hash table slots */
export const MIN_HASH_TABLE_SIZE = 32;

/** Size of a single hash table entry in bytes */
export const HASH_TABLE_ENTRY_SIZE = 16;

/** Size of a single block table entry in bytes */
export const BLOCK_TABLE_ENTRY_SIZE = 16;

/** Sentinel value for empty hash table slots */
export const HASH_TABLE_EMPTY_ENTRY = 0xFFFFFFFF;

/** Encryption key for the hash table */
export const HASH_TABLE_KEY = 0xC3AF3770;

/** Encryption key for the block table */
export const BLOCK_TABLE_KEY = 0xEC83B3A3;

// Hash types for hashString()
export const MPQ_HASH_TABLE_INDEX = 0x000;
export const MPQ_HASH_NAME_A = 0x100;
export const MPQ_HASH_NAME_B = 0x200;
export const MPQ_HASH_FILE_KEY = 0x300;
export const MPQ_HASH_KEY2_MIX = 0x400;

// Block entry flags
export const MPQ_FILE_IMPLODE = 0x00000100;
export const MPQ_FILE_COMPRESS = 0x00000200;
export const MPQ_FILE_ENCRYPTED = 0x00010000;
export const MPQ_FILE_ADJUST_KEY = 0x00020000;
export const MPQ_FILE_EXISTS = 0x80000000;

// Compression type bytes
export const COMPRESSION_HUFFMAN = 0x01;
export const COMPRESSION_ZLIB = 0x02;
export const COMPRESSION_PKWARE = 0x08;
export const COMPRESSION_BZIP2 = 0x10;
export const COMPRESSION_IMA_ADPCM_MONO = 0x40;
export const COMPRESSION_IMA_ADPCM_STEREO = 0x80;

/**
 * ASCII uppercase lookup table (slash-sensitive).
 * Maps a-z to A-Z, leaves '/' as '/'.
 */
export const ASCII_UPPER_LOOKUP_SLASH_SENSITIVE: Uint8Array = (() => {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        table[i] = i;
    }
    // Map lowercase to uppercase
    for (let i = 0x61; i <= 0x7A; i++) {
        table[i] = i - 0x20;
    }
    return table;
})();
