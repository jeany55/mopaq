/**
 * Compression and decompression utilities for MPQ sectors.
 */
import * as zlib from 'zlib';
import { promisify } from 'util';
import {
    COMPRESSION_ZLIB,
    COMPRESSION_BZIP2,
    COMPRESSION_HUFFMAN,
    COMPRESSION_PKWARE,
    COMPRESSION_IMA_ADPCM_MONO,
    COMPRESSION_IMA_ADPCM_STEREO,
} from './consts';
import { MpqError } from './error';

const inflateAsync = promisify(zlib.inflate);
const deflateAsync = promisify(zlib.deflate);

/**
 * Validate compression type and return the payload (data after compression byte).
 * Throws on unsupported compression types.
 */
function validateAndExtractPayload(data: Uint8Array, uncompressedSize: number): { payload: Uint8Array; compressionType: number } | null {
    if (data.length >= uncompressedSize) {
        return null; // not compressed
    }

    const compressionType = data[0];
    const payload = data.subarray(1);

    if (compressionType & COMPRESSION_IMA_ADPCM_MONO) {
        throw new MpqError('UnsupportedCompression', 'IMA ADPCM Mono');
    }
    if (compressionType & COMPRESSION_IMA_ADPCM_STEREO) {
        throw new MpqError('UnsupportedCompression', 'IMA ADPCM Stereo');
    }
    if (compressionType & COMPRESSION_HUFFMAN) {
        throw new MpqError('UnsupportedCompression', 'Huffman');
    }
    if (compressionType & COMPRESSION_PKWARE) {
        throw new MpqError('UnsupportedCompression', 'PKWare DCL');
    }
    if (compressionType & COMPRESSION_BZIP2) {
        throw new MpqError('UnsupportedCompression', 'bzip2 (not available in this build)');
    }

    return { payload, compressionType };
}

/**
 * Decompress a single MPQ sector (synchronous).
 * The first byte is the compression type bitmask.
 */
export function decompressSector(data: Uint8Array, uncompressedSize: number): Uint8Array {
    const extracted = validateAndExtractPayload(data, uncompressedSize);
    if (!extracted) return data;

    let result = extracted.payload;
    if (extracted.compressionType & COMPRESSION_ZLIB) {
        result = new Uint8Array(zlib.inflateSync(Buffer.from(result)));
    }
    return result;
}

/**
 * Decompress a single MPQ sector (asynchronous).
 * The first byte is the compression type bitmask.
 */
export async function decompressSectorAsync(data: Uint8Array, uncompressedSize: number): Promise<Uint8Array> {
    const extracted = validateAndExtractPayload(data, uncompressedSize);
    if (!extracted) return data;

    let result = extracted.payload;
    if (extracted.compressionType & COMPRESSION_ZLIB) {
        result = new Uint8Array(await inflateAsync(Buffer.from(result)));
    }
    return result;
}

/**
 * Compress a sector using zlib (synchronous).
 * Returns compressed data with compression type byte prepended,
 * or the original data if compression doesn't help.
 */
export function compressSector(data: Uint8Array): Uint8Array {
    const compressed = zlib.deflateSync(Buffer.from(data), { level: 9 });

    if (compressed.length + 1 >= data.length) {
        return data;
    }

    const result = new Uint8Array(compressed.length + 1);
    result[0] = COMPRESSION_ZLIB;
    result.set(compressed, 1);
    return result;
}

/**
 * Compress a sector using zlib (asynchronous).
 * Returns compressed data with compression type byte prepended,
 * or the original data if compression doesn't help.
 */
export async function compressSectorAsync(data: Uint8Array): Promise<Uint8Array> {
    const compressed = await deflateAsync(Buffer.from(data), { level: 9 });

    if (compressed.length + 1 >= data.length) {
        return data;
    }

    const result = new Uint8Array(compressed.length + 1);
    result[0] = COMPRESSION_ZLIB;
    result.set(compressed, 1);
    return result;
}
