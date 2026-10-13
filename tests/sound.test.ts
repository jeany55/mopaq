import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { adpcmDecompress } from '../src/adpcm';
import { decompressSector, decompressSectorAsync } from '../src/compression';
import { MpqError } from '../src/error';
import { huffmanDecompress } from '../src/huffman';

/** 16-bit little-endian samples as numbers. */
function samples(pcm: Uint8Array): number[] {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return Array.from({ length: pcm.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

/**
 * The streams here are worked out by hand from the format, not produced by the decoder
 * under test: the tree of data type 0 has four leaves to begin with (byte 0x00 at weight
 * 10, 0xFF at 2, the end mark and the new-byte mark at 1 each), which gives the codes
 * 1 for 0x00, 01 for 0xFF, 001 for the end and 000 for a new byte, bits taken from each
 * stream byte lowest first.
 */
describe('MPQ Huffman', () => {
    it('decodes bytes the starting tree already has', () => {
        // 0x00, 0x00, 0xFF, end: 1 1 01 001, which is 0x4B lowest bit first.
        assert.deepStrictEqual([...huffmanDecompress(new Uint8Array([0x00, 0x4b]), 16)], [0x00, 0x00, 0xff]);
    });

    it('learns a byte it has not seen, and finds the end mark where the changed tree puts it', () => {
        // New byte (000), its eight bits (0x41), then the end mark, which the insertion and
        // the rebalancing after it have moved to 0110.
        assert.deepStrictEqual([...huffmanDecompress(new Uint8Array([0x00, 0x08, 0x32]), 16)], [0x41]);
    });

    it('stops at the size asked for', () => {
        assert.deepStrictEqual([...huffmanDecompress(new Uint8Array([0x00, 0x4b]), 2)], [0x00, 0x00]);
    });

    it('rejects a stream that runs out before its end mark', () => {
        // Eight zero bytes and then nothing: never an end mark.
        assert.throws(() => huffmanDecompress(new Uint8Array([0x00, 0xff]), 64), (e) => e instanceof MpqError && e.kind === 'Corrupted');
        assert.throws(() => huffmanDecompress(new Uint8Array([]), 4), MpqError);
    });

    it('rejects a data type it has no table for', () => {
        assert.throws(() => huffmanDecompress(new Uint8Array([0x0f, 0x00]), 4), (e) => e instanceof MpqError && e.kind === 'Corrupted');
    });

    it('is the 0x01 stage of a sector', async () => {
        // (A sector is taken as compressed only when it is shorter than what it decodes to.)
        // Eight zero bytes, one bit each, then the end mark.
        const sector = new Uint8Array([0x01, 0x00, 0xff, 0x04]);
        const zeros = [0, 0, 0, 0, 0, 0, 0, 0];
        assert.deepStrictEqual([...decompressSector(sector, 8)], zeros);
        assert.deepStrictEqual([...(await decompressSectorAsync(sector, 8))], zeros);
    });
});

/**
 * Worked by hand as well. The step index starts at 44 (a step of 494) and the shift of
 * 4 makes the smallest move a sixteenth of the step.
 */
describe('MPQ IMA ADPCM', () => {
    it('decodes mono: a repeat, a rise, a fall, a wider step', () => {
        const stream = new Uint8Array([
            0x00, 0x04, // always zero, then the shift
            0xe8, 0x03, // the first sample, 1000, as it is
            0x80, // the same again; the step index drops to 43 (449)
            0x01, // up by 449/16 + 449 = 477
            0x41, // down by the same
            0x81, // the step index up eight places to 51 (963); no sample
            0x00, // up by 963/16 = 60
        ]);
        assert.deepStrictEqual(samples(adpcmDecompress(stream, 64, 1)), [1000, 1000, 1477, 1000, 1060]);
    });

    it('holds a sample at the ends of the 16-bit range', () => {
        // Every magnitude bit set at a step of 494 moves by 1000.
        assert.deepStrictEqual(samples(adpcmDecompress(new Uint8Array([0x00, 0x04, 0xf8, 0x7f, 0x3f]), 64, 1)), [32760, 32767]);
        assert.deepStrictEqual(samples(adpcmDecompress(new Uint8Array([0x00, 0x04, 0x08, 0x80, 0x7f]), 64, 1)), [-32760, -32768]);
    });

    it('decodes stereo with the channels taking turns, each with its own step', () => {
        const stream = new Uint8Array([
            0x00, 0x04,
            0x64, 0x00, // left starts at 100
            0x9c, 0xff, // right at -100
            0x01, // left up 494/16 + 494 = 524
            0x80, // right repeats, and its step narrows to 449
            0x81, // left's step widens eight places to 1060 (no sample; left goes again)
            0x00, // left up 1060/16 = 66
            0x00, // right up 449/16 = 28
        ]);
        assert.deepStrictEqual(samples(adpcmDecompress(stream, 64, 2)), [100, -100, 624, -100, 690, -72]);
    });

    it('stops when the output is full, and yields nothing from a stream too short to start', () => {
        const stream = new Uint8Array([0x00, 0x04, 0xe8, 0x03, 0x80, 0x80, 0x80]);
        assert.deepStrictEqual(samples(adpcmDecompress(stream, 4, 1)), [1000, 1000]);
        assert.strictEqual(adpcmDecompress(new Uint8Array([0x00]), 8, 1).length, 0);
        assert.strictEqual(adpcmDecompress(new Uint8Array([0x00, 0x04, 0xe8]), 8, 1).length, 0);
    });

    it('follows Huffman when a sector has both, as every sound in a game archive does', async () => {
        // The ADPCM stream 00 04 | 00 00 | 00 00 00 00: shift 4, a first sample of 0, four
        // smallest rises on a narrowing step (494, 449, 408, 371, each over 16).
        // Packed by hand: 0x00 (1), a new byte 0x04 (000 and its bits), 0x00 six times,
        // and the end mark at 0110, where learning 0x04 left it.
        const sector = new Uint8Array([0x41, 0x00, 0x41, 0xf0, 0x1b]);
        assert.deepStrictEqual([...huffmanDecompress(sector.subarray(1), 10)], [0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        assert.deepStrictEqual(samples(decompressSector(sector, 10)), [0, 30, 58, 83, 106]);
        assert.deepStrictEqual(samples(await decompressSectorAsync(sector, 10)), [0, 30, 58, 83, 106]);
    });

    it('is the 0x40 and 0x80 stage of a sector', async () => {
        const mono = new Uint8Array([0x40, 0x00, 0x04, 0xe8, 0x03, 0x80, 0x80, 0x80, 0x80, 0x80]);
        const six = [1000, 1000, 1000, 1000, 1000, 1000];
        assert.deepStrictEqual(samples(decompressSector(mono, 12)), six);
        assert.deepStrictEqual(samples(await decompressSectorAsync(mono, 12)), six);
        const stereo = new Uint8Array([0x80, 0x00, 0x04, 0x64, 0x00, 0x9c, 0xff, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
        assert.deepStrictEqual(samples(decompressSector(stereo, 16)), [100, -100, 100, -100, 100, -100, 100, -100]);
    });
});
