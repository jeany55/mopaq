import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { explode } from '../src/pkware';
import { decompressSector, decompressSectorAsync } from '../src/compression';
import { MpqError } from '../src/error';

/**
 * The canonical test vector from zlib's blast.c: an implode stream that decodes to
 * "AIAIAIAIAIAIA". It exercises literals, a length/distance pair and the end code.
 */
const BLAST_SAMPLE = new Uint8Array([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);
const BLAST_EXPECTED = 'AIAIAIAIAIAIA';

describe('PKWARE DCL', () => {
    it('decodes the blast.c reference stream', () => {
        const out = explode(BLAST_SAMPLE, BLAST_EXPECTED.length);
        assert.strictEqual(new TextDecoder().decode(out), BLAST_EXPECTED);
    });

    it('stops at the requested output size', () => {
        const out = explode(BLAST_SAMPLE, 5);
        assert.strictEqual(new TextDecoder().decode(out), BLAST_EXPECTED.slice(0, 5));
    });

    it('rejects a stream with an invalid literal mode', () => {
        assert.throws(() => explode(new Uint8Array([0x02, 0x04, 0x00]), 4), MpqError);
    });

    it('rejects a stream with an invalid dictionary size', () => {
        assert.throws(() => explode(new Uint8Array([0x00, 0x09, 0x00]), 4), MpqError);
    });

    it('rejects a truncated stream', () => {
        assert.throws(() => explode(new Uint8Array([0x00]), 4), MpqError);
    });

    it('is reachable through the sector decompressor', () => {
        // Compression byte 0x08 = PKWARE, followed by the stream itself.
        const sector = new Uint8Array(BLAST_SAMPLE.length + 1);
        sector[0] = 0x08;
        sector.set(BLAST_SAMPLE, 1);

        const out = decompressSector(sector, BLAST_EXPECTED.length);
        assert.strictEqual(new TextDecoder().decode(out), BLAST_EXPECTED);
    });

    it('is reachable through the async sector decompressor', async () => {
        const sector = new Uint8Array(BLAST_SAMPLE.length + 1);
        sector[0] = 0x08;
        sector.set(BLAST_SAMPLE, 1);

        const out = await decompressSectorAsync(sector, BLAST_EXPECTED.length);
        assert.strictEqual(new TextDecoder().decode(out), BLAST_EXPECTED);
    });
});

/* ── Compression ─────────────────────────────────────────── */

import { implode } from '../src/pkware';
import { compressSector, compressSectorAsync } from '../src/compression';

function pseudoRandom(n: number, seed = 1): Uint8Array {
    const out = new Uint8Array(n);
    let x = seed >>> 0;
    for (let i = 0; i < n; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

/** Something a map file looks like: runs, small structured records and a little text. */
function mapLike(n: number): Uint8Array {
    const out = new Uint8Array(n);
    const words = ['Terran', 'Zerg', 'Protoss', 'Marine', 'Zealot', 'Hydralisk'];
    for (let i = 0; i < n; i++) {
        const block = Math.floor(i / 1000) % 4;
        if (block === 0) out[i] = 0;
        else if (block === 1) out[i] = (i * 7) & 0xff;
        else if (block === 2) out[i] = i % 3 === 0 ? 0x40 : 0x00;
        else out[i] = words[Math.floor(i / 8) % words.length].charCodeAt(i % 6) ?? 0x20;
    }
    return out;
}

const roundTrip = (data: Uint8Array, options?: Parameters<typeof implode>[1]) =>
    explode(implode(data, options), data.length);

describe('PKWARE DCL compression', () => {
    it('reproduces the blast.c reference stream byte for byte', () => {
        const packed = implode(new TextEncoder().encode(BLAST_EXPECTED), { dictionarySize: 1024, ascii: false });
        assert.deepStrictEqual(Array.from(packed), Array.from(BLAST_SAMPLE));
    });

    it('round-trips empty, tiny and one-byte inputs', () => {
        for (const data of [new Uint8Array(0), new Uint8Array([7]), new Uint8Array([1, 2]), new Uint8Array([5, 5, 5])]) {
            assert.deepStrictEqual(roundTrip(data), data);
        }
    });

    it('round-trips random, repetitive and map-like data at every dictionary size and both literal modes', () => {
        const inputs = [
            pseudoRandom(5000),
            new Uint8Array(70000).fill(0),
            mapLike(150000),
            new TextEncoder().encode('the quick brown fox jumps over the lazy dog '.repeat(400)),
        ];
        for (const data of inputs) {
            for (const dictionarySize of [1024, 2048, 4096] as const) {
                for (const ascii of [false, true, undefined]) {
                    assert.deepStrictEqual(roundTrip(data, { dictionarySize, ascii }), data);
                }
            }
        }
    });

    it('uses every copy length the format allows', () => {
        // A byte followed by 600 copies of it needs the longest codes and the two-byte copy.
        const data = new Uint8Array(601).fill(0xab);
        data[0] = 0x01;
        assert.deepStrictEqual(roundTrip(data), data);
        // Two-byte repeats at growing distances, up to the 256-byte reach of a short copy.
        const pairs = new Uint8Array(2000);
        for (let i = 0; i < pairs.length; i++) pairs[i] = (i % 2 === 0 ? 0x10 : 0x20) + (Math.floor(i / 2) % 130 === 0 ? 1 : 0);
        assert.deepStrictEqual(roundTrip(pairs), pairs);
    });

    it('shrinks compressible data and never exceeds the input by more than the header and end code', () => {
        const zeros = new Uint8Array(4096).fill(0);
        assert.ok(implode(zeros).length < 64, `zeros packed to ${implode(zeros).length}`);
        const text = new TextEncoder().encode('scenario.chk '.repeat(300));
        assert.ok(implode(text).length < text.length / 4);
        const noise = pseudoRandom(4096);
        assert.ok(implode(noise, { ascii: false }).length <= noise.length + 4 + noise.length / 8);
    });

    it('picks the cheaper literal mode by itself', () => {
        const text = new TextEncoder().encode('Alpha Beta Gamma Delta '.repeat(50));
        assert.strictEqual(implode(text)[0], 1, 'text is Huffman-coded');
        assert.strictEqual(implode(pseudoRandom(2000))[0], 0, 'noise is stored as bytes');
        assert.strictEqual(implode(text, { ascii: false })[0], 0);
    });

    it('rejects a dictionary size the format has no code for', () => {
        assert.throws(() => implode(new Uint8Array(4), { dictionarySize: 512 as unknown as 1024 }), MpqError);
    });

    it('feeds a sector with the PKWARE type byte, sync and async', async () => {
        const data = mapLike(4096);
        const packed = compressSector(data, 'pkware');
        assert.strictEqual(packed[0], 0x08);
        assert.deepStrictEqual(decompressSector(packed, data.length), data);
        assert.deepStrictEqual(await decompressSectorAsync(await compressSectorAsync(data, 'pkware'), data.length), data);
        // Incompressible data is stored as it was.
        const noise = pseudoRandom(64);
        assert.deepStrictEqual(compressSector(noise, 'pkware'), noise);
    });
});
