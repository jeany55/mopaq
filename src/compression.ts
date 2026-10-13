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
import { adpcmDecompress } from './adpcm';
import { MpqError } from './error';
import { huffmanDecompress } from './huffman';
import { explode, implode } from './pkware';

/** How a sector is compressed when writing: zlib (smaller, modern readers) or PKWARE DCL (what Blizzard's own tools wrote). */
export type CompressionMethod = 'zlib' | 'pkware';

/** DEFLATE compression level used when writing archives (0-9). */
const COMPRESSION_LEVEL = 9;

type FlateCallback = (err: FlateError | null, data: Uint8Array) => void;
type CbCompressor = (data: Uint8Array, cb: FlateCallback) => unknown;

/**
 * Payloads smaller than this are handled on the calling thread even by the async API.
 * fflate starts a Worker for every async call, which costs milliseconds against the
 * fraction of one a sector takes: an archive of 4 KB sectors paid for a Worker per sector,
 * thousands of them for a few megabytes, and was an order of magnitude slower through the
 * async API than the sync one. A sector is at most `512 << sectorSizeShift` bytes, so only
 * an archive of unusually large sectors goes to a Worker at all; the callers keep the
 * thread responsive with `pacer` instead.
 */
const WORKER_THRESHOLD = 512 * 1024;

/** How long the async API works on the calling thread before handing it back, in ms. */
const PACE_MS = 12;

/**
 * For a loop that does its work on the calling thread: the returned function resolves at
 * once while the loop is inside its time budget, and after a turn of the event loop once
 * it has used it up, so a long archive does not hold the thread from start to finish.
 */
export function pacer(): () => Promise<void> | undefined {
    let since = Date.now();
    return () => {
        if (Date.now() - since < PACE_MS) return undefined;
        return new Promise<void>(resolve => setTimeout(() => {
            since = Date.now();
            resolve();
        }, 0));
    };
}

/**
 * Run one of fflate's worker-backed async functions as a Promise — or, for a payload
 * under `WORKER_THRESHOLD`, its synchronous counterpart.
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
        if (data.length < WORKER_THRESHOLD) {
            try {
                resolve(syncFn(data));
            } catch (e) {
                reject(wrapFlateError(e));
            }
            return;
        }
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
    return unpackSound(result, extracted.compressionType, uncompressedSize);
}

/**
 * The two stages a sound goes through, last of all on the way out: Huffman, then ADPCM
 * (an archive applies ADPCM first and packs its bytes with Huffman). Neither has an
 * asynchronous form; a sector of sound is a few kilobytes.
 */
function unpackSound(data: Uint8Array, compressionType: number, uncompressedSize: number): Uint8Array {
    let result = data;
    if (compressionType & COMPRESSION_HUFFMAN) {
        result = huffmanDecompress(result, uncompressedSize);
    }
    if (compressionType & COMPRESSION_IMA_ADPCM_STEREO) {
        result = adpcmDecompress(result, uncompressedSize, 2);
    }
    if (compressionType & COMPRESSION_IMA_ADPCM_MONO) {
        result = adpcmDecompress(result, uncompressedSize, 1);
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
    return unpackSound(result, extracted.compressionType, uncompressedSize);
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
 * zlib runs off-thread where fflate can and the sector is large enough to be worth a
 * Worker; PKWARE is the library's own encoder and runs on the calling thread. Returns compressed data with compression type byte prepended,
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
