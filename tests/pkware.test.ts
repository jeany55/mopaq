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
