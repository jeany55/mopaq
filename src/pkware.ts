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
 * Compression (`implode`) is implemented too: it is what StarEdit and the game's own
 * archives use, so it is the one compression every StarCraft build reads. The encoder is
 * an LZ77 matcher over the format's 1 K / 2 K / 4 K dictionary with the same fixed code
 * tables, and its output is checked against the format's reference stream in the tests.
 */
import { MpqError } from './error';

const MAX_BITS = 13;
const MAX_WINDOW = 4096;
/** The longest copy the length codes can express (519 is the end-of-stream marker). */
const MAX_MATCH = 518;
/** A two-byte copy carries only two low distance bits, so it can reach back this far at most. */
const MAX_SHORT_DISTANCE = 256;

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


/* ── Compression ─────────────────────────────────────────── */

interface Codes {
    /** Canonical code per symbol, read most significant bit first. */
    code: Uint16Array;
    /** Code length per symbol. */
    bits: Uint8Array;
}

/**
 * The encoder's view of a code table: the canonical code of every symbol. Codes are
 * assigned exactly as `construct` orders the symbols — by length, then by symbol — so
 * `decode` reads them back; the bit inversion happens when the bits are written.
 */
function buildCodes(runs: number[]): Codes {
    const lengths: number[] = [];
    for (const run of runs) {
        const repeat = (run >> 4) + 1;
        const bits = run & 15;
        for (let i = 0; i < repeat; i++) lengths.push(bits);
    }
    const code = new Uint16Array(lengths.length);
    const bits = new Uint8Array(lengths.length);
    let next = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
        for (let s = 0; s < lengths.length; s++) {
            if (lengths[s] !== len) continue;
            code[s] = next++;
            bits[s] = len;
        }
        next <<= 1;
    }
    return { code, bits };
}

const literalCodes = buildCodes(LITERAL_LENGTHS);
const lengthCodes = buildCodes(LENGTH_LENGTHS);
const distanceCodes = buildCodes(DISTANCE_LENGTHS);

/** The length symbol for every copy length 2..518, and the bits the whole length costs. */
const LENGTH_SYMBOL = new Uint8Array(MAX_MATCH + 1);
const LENGTH_COST = new Uint8Array(MAX_MATCH + 1);
for (let symbol = 0; symbol < LENGTH_BASE.length; symbol++) {
    const base = LENGTH_BASE[symbol];
    const span = 1 << LENGTH_EXTRA[symbol];
    for (let len = base; len < base + span && len <= MAX_MATCH; len++) {
        LENGTH_SYMBOL[len] = symbol;
        LENGTH_COST[len] = lengthCodes.bits[symbol] + LENGTH_EXTRA[symbol];
    }
}

export interface ImplodeOptions {
    /**
     * Dictionary (window) size in bytes: 1024, 2048 or 4096. Larger finds more matches and
     * costs one bit more per distance; 4096 is the usual choice and the default.
     */
    dictionarySize?: 1024 | 2048 | 4096;
    /**
     * Huffman-code the literals — the format's "ASCII" mode, which helps text and hurts
     * binary data. Left unset, the encoder measures both on the data and picks the smaller.
     */
    ascii?: boolean;
}

/**
 * Compress with PKWARE DCL "implode".
 *
 * The output is the two-byte header (literal mode, dictionary bits) followed by the bit
 * stream, exactly what `explode` reads; a compressed MPQ sector carries it after the
 * compression-type byte. Matching is greedy with one step of lazy evaluation, over hash
 * chains for three-byte matches and a last-seen table for the format's two-byte copies,
 * choosing by bits saved rather than by length so a short copy is only taken when it is
 * cheaper than the literals it replaces.
 */
export function implode(data: Uint8Array, options: ImplodeOptions = {}): Uint8Array {
    const dictionarySize = options.dictionarySize ?? 4096;
    const dictBits = dictionarySize === 1024 ? 4 : dictionarySize === 2048 ? 5 : dictionarySize === 4096 ? 6 : 0;
    if (dictBits === 0) {
        throw new MpqError('Corrupted', `PKWare dictionary size must be 1024, 2048 or 4096, not ${dictionarySize}`);
    }
    const ascii = options.ascii ?? asciiIsSmaller(data);

    // Bit writer, least significant bit first, into a buffer that grows as needed.
    let out = new Uint8Array(Math.max(64, (data.length >> 1) + 64));
    let outPos = 0;
    let bitBuf = 0;
    let bitCnt = 0;
    function writeBits(value: number, count: number): void {
        bitBuf |= value << bitCnt;
        bitCnt += count;
        while (bitCnt >= 8) {
            if (outPos >= out.length) {
                const grown = new Uint8Array(out.length * 2);
                grown.set(out);
                out = grown;
            }
            out[outPos++] = bitBuf & 0xff;
            bitBuf >>>= 8;
            bitCnt -= 8;
        }
    }
    /** Write a code the way `decode` reads it: most significant bit first, every bit inverted. */
    function writeCode(codes: Codes, symbol: number): void {
        const bits = codes.bits[symbol];
        const code = codes.code[symbol];
        for (let i = bits - 1; i >= 0; i--) writeBits(((code >> i) & 1) ^ 1, 1);
    }
    function writeLiteral(byte: number): void {
        writeBits(0, 1);
        if (ascii) writeCode(literalCodes, byte);
        else writeBits(byte, 8);
    }
    function writeCopy(length: number, distance: number): void {
        writeBits(1, 1);
        const symbol = LENGTH_SYMBOL[length];
        writeCode(lengthCodes, symbol);
        writeBits(length - LENGTH_BASE[symbol], LENGTH_EXTRA[symbol]);
        const lowBits = length === 2 ? 2 : dictBits;
        const value = distance - 1;
        writeCode(distanceCodes, value >> lowBits);
        writeBits(value & ((1 << lowBits) - 1), lowBits);
    }
    const literalCost = (byte: number) => 1 + (ascii ? literalCodes.bits[byte] : 8);
    /** Bits a copy costs, for weighing it against the literals it replaces. */
    function copyCost(length: number, distance: number): number {
        const lowBits = length === 2 ? 2 : dictBits;
        return 1 + LENGTH_COST[length] + distanceCodes.bits[(distance - 1) >> lowBits] + lowBits;
    }

    writeBits(ascii ? 1 : 0, 8);
    writeBits(dictBits, 8);

    const n = data.length;
    // Hash chains over three-byte prefixes, positions kept modulo the window.
    const HASH_BITS = 14;
    const HASH_SIZE = 1 << HASH_BITS;
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(dictionarySize);
    // The last position of every two-byte pair, for the format's short copies.
    const last2 = new Int32Array(65536).fill(-1);
    const MAX_CHAIN = 1024;
    const hash3 = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);

    function insert(i: number): void {
        if (i + 2 < n) {
            const h = hash3(i);
            prev[i & (dictionarySize - 1)] = head[h];
            head[h] = i;
        }
        if (i + 1 < n) last2[(data[i] << 8) | data[i + 1]] = i;
    }

    /** The copy at `i` that saves the most bits, as [length, distance, saving]; saving ≤ 0 means none. */
    function bestCopy(i: number): [number, number, number] {
        let bestLen = 0;
        let bestDist = 0;
        let bestSaving = 0;
        const maxLen = Math.min(MAX_MATCH, n - i);
        if (maxLen < 2) return [0, 0, 0];
        const bitsOfLiterals = (len: number) => {
            let bits = 0;
            for (let k = 0; k < len; k++) bits += literalCost(data[i + k]);
            return bits;
        };
        if (maxLen >= 3) {
            let chain = MAX_CHAIN;
            let cand = head[hash3(i)];
            while (cand >= 0 && chain-- > 0) {
                const dist = i - cand;
                if (dist > dictionarySize) break;
                if (data[cand + bestLen] === data[i + bestLen] || bestLen === 0) {
                    let len = 0;
                    while (len < maxLen && data[cand + len] === data[i + len]) len++;
                    if (len >= 3) {
                        const saving = bitsOfLiterals(len) - copyCost(len, dist);
                        if (saving > bestSaving || (saving === bestSaving && len > bestLen)) {
                            bestLen = len;
                            bestDist = dist;
                            bestSaving = saving;
                            if (len === maxLen) break;
                        }
                    }
                }
                const next = prev[cand & (dictionarySize - 1)];
                if (next >= cand) break;
                cand = next;
            }
        }
        // A two-byte copy, only where the distance fits its two low bits.
        const cand2 = last2[(data[i] << 8) | data[i + 1]];
        if (cand2 >= 0 && i - cand2 <= MAX_SHORT_DISTANCE) {
            const saving = bitsOfLiterals(2) - copyCost(2, i - cand2);
            if (saving > bestSaving) {
                bestLen = 2;
                bestDist = i - cand2;
                bestSaving = saving;
            }
        }
        return [bestLen, bestDist, bestSaving];
    }

    let i = 0;
    while (i < n) {
        const [len, dist, saving] = bestCopy(i);
        if (saving <= 0) {
            writeLiteral(data[i]);
            insert(i);
            i++;
            continue;
        }
        // Lazy step: a better copy one byte on is worth a literal now.
        if (i + 1 < n) {
            const [len2, , saving2] = bestCopy(i + 1);
            if (len2 > len && saving2 > saving + literalCost(data[i])) {
                writeLiteral(data[i]);
                insert(i);
                i++;
                continue;
            }
        }
        writeCopy(len, dist);
        for (let k = 0; k < len; k++) insert(i + k);
        i += len;
    }

    // End of stream: the copy length the decoder treats as the terminator.
    writeBits(1, 1);
    writeCode(lengthCodes, 15);
    writeBits(END_OF_STREAM - LENGTH_BASE[15], LENGTH_EXTRA[15]);
    if (bitCnt > 0) writeBits(0, 8 - bitCnt);
    return out.subarray(0, outPos);
}

/** Whether Huffman-coded literals would be smaller than raw bytes for this data. */
function asciiIsSmaller(data: Uint8Array): boolean {
    let coded = 0;
    const n = Math.min(data.length, 1 << 16);
    for (let i = 0; i < n; i++) coded += literalCodes.bits[data[i]];
    return coded < n * 8;
}
