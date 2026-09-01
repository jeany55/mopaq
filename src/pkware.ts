/**
 * PKWARE Data Compression Library "implode" decompression (explode).
 *
 * This is the compression Blizzard used for almost everything in the StarCraft and
 * Diablo era, so an MPQ reader without it cannot read those archives at all.
 *
 * The format is a header byte pair followed by an LSB-first bit stream of literals and
 * length/distance pairs, with three fixed Huffman tables. The tables and the decoding
 * order follow Mark Adler's `blast.c` (zlib contrib, public domain), which is the
 * reference implementation of the format.
 *
 * Compression is not implemented: nothing needs to *write* implode, and writing zlib
 * instead is both smaller and universally readable.
 */
import { MpqError } from './error';

const MAX_BITS = 13;
const MAX_WINDOW = 4096;

/**
 * Fixed code tables, stored the way blast.c stores them: one byte per run, where the
 * high nibble is (repeat count - 1) and the low nibble is the code's bit length.
 */
const LITERAL_LENGTHS = [
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
    44, 173,
];
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];

/** Base copy length for each of the 16 length symbols. */
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
/** Extra bits read after each length symbol. */
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The length that means "end of stream" rather than a copy. */
const END_OF_STREAM = 519;

interface Huffman {
    /** Number of symbols of each bit length, indexed by length. */
    count: Int16Array;
    /** Symbols ordered canonically by code. */
    symbol: Int16Array;
}

/** Expand a run-length coded table into a canonical Huffman decoding table. */
function construct(runs: number[]): Huffman {
    const lengths: number[] = [];
    for (const run of runs) {
        const repeat = (run >> 4) + 1;
        const bits = run & 15;
        for (let i = 0; i < repeat; i++) lengths.push(bits);
    }

    const count = new Int16Array(MAX_BITS + 1);
    for (const len of lengths) count[len]++;

    // Reject an over-subscribed set; these tables are constants, so this only fires if
    // the table data above is edited incorrectly.
    let left = 1;
    for (let len = 1; len <= MAX_BITS; len++) {
        left = (left << 1) - count[len];
        if (left < 0) throw new MpqError('Corrupted', 'over-subscribed PKWare code set');
    }

    const offsets = new Int16Array(MAX_BITS + 2);
    for (let len = 1; len <= MAX_BITS; len++) offsets[len + 1] = offsets[len] + count[len];

    const symbol = new Int16Array(lengths.length);
    for (let s = 0; s < lengths.length; s++) {
        if (lengths[s] !== 0) symbol[offsets[lengths[s]]++] = s;
    }

    return { count, symbol };
}

const literalCode = construct(LITERAL_LENGTHS);
const lengthCode = construct(LENGTH_LENGTHS);
const distanceCode = construct(DISTANCE_LENGTHS);

/**
 * Decompress a PKWARE DCL stream.
 *
 * `uncompressedSize` is the expected output length, which MPQ always knows; decoding
 * stops there even if the stream would produce more.
 *
 * Perf: bit-reader state is kept in local variables (no class/object overhead) and the
 * inner copy loop uses `copyWithin` for non-overlapping runs.
 */
export function explode(data: Uint8Array, uncompressedSize: number): Uint8Array {
    if (data.length < 2) {
        throw new MpqError('Corrupted', 'PKWare stream too short for a header');
    }

    // Inline bit-reader state — avoids object property access in the hot loop.
    let rPos = 0;
    let rBuf = 0;
    let rCnt = 0;
    const rData = data;
    const rLen = data.length;

    /** Read `need` bits, least significant bit first. */
    function read(need: number): number {
        while (rCnt < need) {
            if (rPos >= rLen) {
                throw new MpqError('Corrupted', 'PKWare stream ended mid-symbol');
            }
            rBuf |= rData[rPos++] << rCnt;
            rCnt += 8;
        }
        const value = rBuf & ((1 << need) - 1);
        rBuf >>>= need;
        rCnt -= need;
        return value;
    }

    /** Decode one Huffman symbol. */
    function decode(code: Huffman): number {
        let value = 0;
        let first = 0;
        let index = 0;
        const cnt = code.count;
        const sym = code.symbol;
        for (let len = 1; len <= MAX_BITS; len++) {
            value |= read(1) ^ 1;
            const c = cnt[len];
            if (value - first < c) return sym[index + (value - first)];
            index += c;
            first = (first + c) << 1;
            value <<= 1;
        }
        throw new MpqError('Corrupted', 'invalid PKWare Huffman code');
    }

    const literalsCoded = read(8);
    if (literalsCoded > 1) {
        throw new MpqError('Corrupted', `invalid PKWare literal mode ${literalsCoded}`);
    }
    const dictBits = read(8);
    if (dictBits < 4 || dictBits > 6) {
        throw new MpqError('Corrupted', `invalid PKWare dictionary size ${dictBits}`);
    }

    const out = new Uint8Array(uncompressedSize);
    let written = 0;

    while (written < uncompressedSize) {
        if (read(1)) {
            // Length/distance pair.
            const lengthSymbol = decode(lengthCode);
            const length = LENGTH_BASE[lengthSymbol] + read(LENGTH_EXTRA[lengthSymbol]);
            if (length === END_OF_STREAM) break;

            const lowBits = length === 2 ? 2 : dictBits;
            const distance = ((decode(distanceCode) << lowBits) | read(lowBits)) + 1;
            if (distance > written || distance > MAX_WINDOW) {
                throw new MpqError('Corrupted', 'PKWare distance points before the output');
            }

            const copy = Math.min(length, uncompressedSize - written);
            // Fast path: non-overlapping copies can use copyWithin.
            if (distance >= copy) {
                out.copyWithin(written, written - distance, written - distance + copy);
                written += copy;
            } else {
                // Overlapping copy — must go byte by byte.
                for (let i = 0; i < copy; i++) {
                    out[written] = out[written - distance];
                    written++;
                }
            }
        } else {
            out[written++] = literalsCoded ? decode(literalCode) : read(8);
        }
    }

    return written === uncompressedSize ? out : out.subarray(0, written);
}
