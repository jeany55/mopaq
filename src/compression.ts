/**
 * Compression and decompression utilities for MPQ sectors.
 */
import * as zlib from 'zlib';
import {
    COMPRESSION_ZLIB,
    COMPRESSION_BZIP2,
    COMPRESSION_HUFFMAN,
    COMPRESSION_PKWARE,
    COMPRESSION_IMA_ADPCM_MONO,
    COMPRESSION_IMA_ADPCM_STEREO,
} from './consts';
import { MpqError } from './error';

/**
 * Decompress a single MPQ sector.
 * The first byte is the compression type bitmask.
 */
export function decompressSector(data: Uint8Array, uncompressedSize: number): Uint8Array {
    if (data.length >= uncompressedSize) {
        return data;
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

    let result = payload;

    if (compressionType & COMPRESSION_BZIP2) {
        // bzip2 not natively supported in Node.js, but we can try
        throw new MpqError('UnsupportedCompression', 'bzip2 (not available in this build)');
    }

    if (compressionType & COMPRESSION_ZLIB) {
        result = new Uint8Array(zlib.inflateSync(Buffer.from(result)));
    }

    return result;
}

/**
 * Compress a sector using zlib.
 * Returns compressed data with compression type byte prepended,
 * or the original data if compression doesn't help.
 */
export function compressSector(data: Uint8Array): Uint8Array {
    const compressed = zlib.deflateSync(Buffer.from(data), { level: 9 });

    // If compression doesn't help (compressed + 1 byte header >= original), return raw
    if (compressed.length + 1 >= data.length) {
        return data;
    }

    const result = new Uint8Array(compressed.length + 1);
    result[0] = COMPRESSION_ZLIB;
    result.set(compressed, 1);
    return result;
}
