/**
 * Compression and decompression utilities for MPQ sectors.
 *
 * MPQ stores zlib-wrapped DEFLATE streams (RFC 1950), so this module uses
 * fflate's `zlibSync`/`unzlibSync` rather than its raw-DEFLATE counterparts.
 * fflate is used in place of Node's `zlib` so the library runs unchanged in
 * browsers, Deno, Bun, and edge runtimes.
 *
 * PKWARE DCL (see ./pkware) is handled both ways: it is what StarCraft- and Diablo-era
 * archives use for nearly every file, and the one compression every build of those games
 * reads, so a writer targeting them asks for `'pkware'`.
 */
import {
    zlibSync,
    unzlibSync,
    zlib as zlibCb,
    unzlib as unzlibCb,
    type FlateError,
} from 'fflate';
import {
    COMPRESSION_ZLIB,
    COMPRESSION_BZIP2,
    COMPRESSION_HUFFMAN,
    COMPRESSION_PKWARE,
    COMPRESSION_IMA_ADPCM_MONO,
    COMPRESSION_IMA_ADPCM_STEREO,
} from './consts';
import { MpqError } from './error';
import { explode, implode } from './pkware';

/** How a sector is compressed when writing: zlib (smaller, modern readers) or PKWARE DCL (what Blizzard's own tools wrote). */
export type CompressionMethod = 'zlib' | 'pkware';

/** DEFLATE compression level used when writing archives (0-9). */
const COMPRESSION_LEVEL = 9;

type FlateCallback = (err: FlateError | null, data: Uint8Array) => void;
type CbCompressor = (data: Uint8Array, cb: FlateCallback) => unknown;

/**
 * Run one of fflate's worker-backed async functions as a Promise.
 *
 * fflate offloads to a Worker (`worker_threads` on the server, a Web Worker in
 * the browser). Where Workers are unavailable — a strict `worker-src` CSP, a
 * runtime without them — construction throws synchronously; we fall back to the
 * synchronous implementation so the async API keeps working, just on-thread.
 */
function runAsync(
    asyncFn: CbCompressor,
    syncFn: (data: Uint8Array) => Uint8Array,
    data: Uint8Array,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        let settled = false;
        try {
            asyncFn(data, (err, result) => {
                settled = true;
                if (err) reject(wrapFlateError(err));
                else resolve(result);
            });
        } catch (e) {
            if (settled) return;
            try {
                resolve(syncFn(data));
            } catch (syncError) {
                reject(wrapFlateError(syncError));
            }
        }
    });
}

/** Present a compression failure as a domain error rather than a raw fflate error. */
function wrapFlateError(e: unknown): MpqError {
    if (e instanceof MpqError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new MpqError('Corrupted', `zlib stream error: ${message}`);
}

function inflate(data: Uint8Array): Uint8Array {
    try {
        return unzlibSync(data);
    } catch (e) {
        throw wrapFlateError(e);
    }
}

function deflate(data: Uint8Array): Uint8Array {
    return zlibSync(data, { level: COMPRESSION_LEVEL });
}

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
    if (compressionType & COMPRESSION_BZIP2) {
        throw new MpqError('UnsupportedCompression', 'bzip2 (not available in this build)');
    }

    return { payload, compressionType };
}

/** Prepend the compression-type byte, or return the original if compression didn't help. */
function packCompressed(compressed: Uint8Array, original: Uint8Array, type: number): Uint8Array {
    if (compressed.length + 1 >= original.length) {
        return original;
    }

    const result = new Uint8Array(compressed.length + 1);
    result[0] = type;
    result.set(compressed, 1);
    return result;
}

/**
 * Decompress a single MPQ sector (synchronous).
 * The first byte is the compression type bitmask.
 */
export function decompressSector(data: Uint8Array, uncompressedSize: number): Uint8Array {
    const extracted = validateAndExtractPayload(data, uncompressedSize);
    if (!extracted) return data;

    let result = extracted.payload;
    // Multi-compression is applied in this order on the way out. In practice archives
    // set exactly one bit, but the chain is harmless when they do not.
    if (extracted.compressionType & COMPRESSION_PKWARE) {
        result = explode(result, uncompressedSize);
    }
    if (extracted.compressionType & COMPRESSION_ZLIB) {
        result = inflate(result);
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
    if (extracted.compressionType & COMPRESSION_PKWARE) {
        result = explode(result, uncompressedSize);
    }
    if (extracted.compressionType & COMPRESSION_ZLIB) {
        result = await runAsync(unzlibCb as CbCompressor, unzlibSync, result);
    }
    return result;
}

/**
 * Decompress a sector of a file carrying the old `MPQ_FILE_IMPLODE` flag: the whole sector
 * is one PKWARE stream with no compression-type byte, or stored raw when it did not shrink.
 */
export function explodeSector(data: Uint8Array, uncompressedSize: number): Uint8Array {
    return data.length >= uncompressedSize ? data : explode(data, uncompressedSize);
}

/**
 * Compress a sector (synchronous).
 * Returns compressed data with compression type byte prepended,
 * or the original data if compression doesn't help.
 */
export function compressSector(data: Uint8Array, method: CompressionMethod = 'zlib'): Uint8Array {
    if (method === 'pkware') return packCompressed(implode(data), data, COMPRESSION_PKWARE);
    return packCompressed(deflate(data), data, COMPRESSION_ZLIB);
}

/**
 * Compress a sector (asynchronous).
 * zlib runs off-thread where fflate can; PKWARE is the library's own encoder and runs on
 * the calling thread. Returns compressed data with compression type byte prepended,
 * or the original data if compression doesn't help.
 */
export async function compressSectorAsync(data: Uint8Array, method: CompressionMethod = 'zlib'): Promise<Uint8Array> {
    if (method === 'pkware') return compressSector(data, method);
    const compressed = await runAsync(
        (d, cb) => zlibCb(d, { level: COMPRESSION_LEVEL }, cb),
        deflate,
        data,
    );
    return packCompressed(compressed, data, COMPRESSION_ZLIB);
}
