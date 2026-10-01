import { workers } from './helpers/count-workers';
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Archive, Creator, MpqError } from '../src/index';
import { pacer } from '../src/compression';

/** Deterministic noise over an alphabet of `symbols` bytes: the smaller the alphabet, the better it deflates. */
function sample(size: number, symbols: number): Uint8Array {
    const out = new Uint8Array(size);
    let x = 0x2545f491;
    for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        out[i] = x % symbols;
    }
    return out;
}

const NAME = 'staredit\\scenario.chk';

function creatorOf(data: Uint8Array, sectorSize: number, options: { encrypt?: boolean } = {}) {
    const creator = new Creator({ sectorSize });
    creator.addFile(NAME, data, { compress: 'zlib', ...options });
    return creator;
}

describe('the async API and workers', () => {
    for (const sectorSize of [512, 4096, 65536]) {
        it(`writes and reads ${sectorSize}-byte sectors without starting a worker, same bytes as the sync API`, async () => {
            const data = sample(600_000, 40);
            workers.reset();
            const written = await creatorOf(data, sectorSize).writeAsync();
            const archive = await Archive.openAsync(written);
            const back = await archive.readFileAsync(NAME);
            const listed = await archive.filesAsync();
            assert.strictEqual(workers.started, 0);
            assert.deepStrictEqual(written, creatorOf(data, sectorSize).write());
            assert.deepStrictEqual(back, data);
            assert.deepStrictEqual(listed, [NAME]);
        });
    }

    it('sends sectors of 512 KB and more to workers, and still writes what the sync API writes', async () => {
        const sectorSize = 1024 * 1024;
        // Barely compressible, so a compressed sector is itself past the threshold and the read uses workers too.
        const data = sample(3 * sectorSize + 12_345, 200);
        workers.reset();
        const written = await creatorOf(data, sectorSize).writeAsync();
        const forWrite = workers.started;
        // Three full sectors; the 12 KB tail is small enough to stay on the calling thread.
        assert.strictEqual(forWrite, 3);
        assert.deepStrictEqual(written, creatorOf(data, sectorSize).write());

        const back = await (await Archive.openAsync(written)).readFileAsync(NAME);
        assert.strictEqual(workers.started - forWrite, 3);
        assert.deepStrictEqual(back, data);
    });

    it('keeps encrypted small sectors on the calling thread too', async () => {
        const data = sample(200_000, 30);
        workers.reset();
        const written = await creatorOf(data, 4096, { encrypt: true }).writeAsync();
        assert.deepStrictEqual(written, creatorOf(data, 4096, { encrypt: true }).write());
        assert.deepStrictEqual(await (await Archive.openAsync(written)).readFileAsync(NAME), data);
        assert.strictEqual(workers.started, 0);
    });

    it('hands the thread back while it writes and reads a long archive', async () => {
        const data = sample(6_000_000, 40);
        let turns = 0;
        const timer = setInterval(() => { turns++; }, 1);
        try {
            const written = await creatorOf(data, 4096).writeAsync();
            const duringWrite = turns;
            const back = await (await Archive.openAsync(written)).readFileAsync(NAME);
            assert.ok(duringWrite >= 2, `the event loop turned ${duringWrite} times during the write`);
            assert.ok(turns - duringWrite >= 2, `the event loop turned ${turns - duringWrite} times during the read`);
            assert.strictEqual(back.length, data.length);
        } finally {
            clearInterval(timer);
        }
    });

    it('rejects a damaged sector as an MpqError, with no rejection left unhandled while it waits', async () => {
        const data = sample(6_000_000, 40);
        const written = await creatorOf(data, 4096).writeAsync();
        // The first file starts after the 32-byte header: its sector offset table, then the
        // sectors. Wreck the first sector's zlib stream but leave its compression-type byte.
        const sectors = Math.ceil(data.length / 4096);
        const firstSector = 32 + (sectors + 1) * 4;
        const damaged = written.slice();
        damaged.fill(0xff, firstSector + 1, firstSector + 40);

        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const archive = await Archive.openAsync(damaged);
            await assert.rejects(() => archive.readFileAsync(NAME), (e: unknown) => e instanceof MpqError);
            // Give a stray rejection the turn it would need to be reported.
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.deepStrictEqual(unhandled, []);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe('pacer', () => {
    it('answers at once inside its budget, and after a turn of the event loop once it is spent', async () => {
        const pause = pacer();
        assert.strictEqual(pause(), undefined);

        const spend = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } };
        spend(30);
        let turned = false;
        setTimeout(() => { turned = true; }, 0);
        const waiting = pause();
        assert.ok(waiting instanceof Promise);
        await waiting;
        assert.ok(turned, 'a timer queued before the pause ran before it resolved');

        // The budget starts again from the pause.
        assert.strictEqual(pause(), undefined);
    });
});
