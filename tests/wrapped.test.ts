/**
 * An archive inside a larger file whose tables lie *before* its header, as a mod patcher's
 * exe lays one out: the header's table positions are relative to the header and wrap at
 * 4 GB (0xFFFF7FF0 is 32,784 bytes before it), and its own size fields say 0xFFFFFFFF. The
 * game's storm reads such an archive; so must `Archive.open`, given the whole file and the
 * header's offset. Also: a table cut short by the end of the data, a fake header passed
 * over by the scan, and of two neutral entries for a name the later one, as storm takes it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Archive, Creator, MpqError } from '../src/index';
import { readFileHeader } from '../src/header';
import { computeHashKey, writeHashTable, type HashEntry } from '../src/table';

const enc = (s: string) => new TextEncoder().encode(s);
const UNITS = new Uint8Array(19876).map((_, i) => (i * 7) & 0xff);
const TEXT = enc('A mod\'s text, long enough to compress. '.repeat(200));

/** A normal archive: two compressed files and a stored one, 4 KB sectors. */
function normal(): Uint8Array {
    const c = new Creator({ sectorSize: 4096, listfile: false });
    c.addFile('arr\\units.dat', UNITS, { compress: 'pkware' });
    c.addFile('rez\\stat_txt.tbl', TEXT, { compress: 'zlib' });
    c.addFile('readme.txt', enc('stored'), { compress: false });
    return c.write();
}

/**
 * `program` bytes of something else (a program and its plugins), then the archive's hash
 * and block tables, then its header and file data — the tables before the header, the
 * header's fields as a patcher writes them. `blockEntries` overrides the block table's
 * stated size (a patcher's says 16,384 where 1,025 fit).
 */
function tablesBefore(program: number, o: { blockEntries?: number; headerAt512?: boolean } = {}): { bytes: Uint8Array; at: number } {
    const orig = normal();
    const v = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);
    const h = readFileHeader(v, 0);
    const hashBytes = orig.subarray(h.hashTableOffset, h.hashTableOffset + h.hashTableEntries * 16);
    const blockBytes = orig.subarray(h.blockTableOffset, h.blockTableOffset + h.blockTableEntries * 16);
    // (the archive itself, its own copies of the tables wiped: only the ones before it are there)
    const archive = orig.slice(0, Math.min(h.hashTableOffset, h.blockTableOffset));
    let at = program + hashBytes.length + blockBytes.length;
    const pad = o.headerAt512 ? (512 - (at % 512)) % 512 : 0;
    at += pad;
    const out = new Uint8Array(at + archive.length);
    for (let i = 0; i < program; i++) out[i] = (i * 31 + 5) & 0xff;
    out.set(hashBytes, program + pad);
    out.set(blockBytes, program + pad + hashBytes.length);
    out.set(archive, at);
    const w = new DataView(out.buffer);
    w.setUint32(at + 4, 0xffffffff, true); // header size: not believed
    w.setUint32(at + 8, 0xffffffff, true); // archive size: not believed
    w.setUint32(at + 16, (program + pad - at) >>> 0, true); // hash table: before the header
    w.setUint32(at + 20, (program + pad + hashBytes.length - at) >>> 0, true); // block table: after it, still before the header
    if (o.blockEntries !== undefined) w.setUint32(at + 28, o.blockEntries, true);
    return { bytes: out, at };
}

function readsAll(a: Archive): void {
    assert.deepStrictEqual(a.readFile('arr\\units.dat'), UNITS);
    assert.deepStrictEqual(a.readFile('rez\\stat_txt.tbl'), TEXT);
    assert.deepStrictEqual(a.readFile('readme.txt'), enc('stored'));
}

describe('tables before the header', () => {
    it('opens with the header offset: positions wrap at 4 GB', () => {
        const { bytes, at } = tablesBefore(1000);
        const a = Archive.open(bytes, { offset: at });
        assert.strictEqual(a.start, at);
        assert.ok(a.tables.hash.start < at && a.tables.block.start < at, 'both tables before the header');
        assert.strictEqual(a.tables.hash.start, 1000);
        readsAll(a);
        const header = new DataView(bytes.buffer).getUint32(at + 16, true);
        assert.ok(header > 0x80000000, 'the header stores the position as a large unsigned number');
    });

    it('does not believe the header\'s own sizes', () => {
        const { bytes, at } = tablesBefore(1000);
        const a = Archive.open(bytes, { offset: at });
        assert.strictEqual(a.size, bytes.length - at, 'what the data holds, not 0xFFFFFFFF');
        assert.strictEqual(a.end, bytes.length);
        assert.strictEqual(a.fileInfo('arr\\units.dat')!.uncompressedSize, UNITS.length);
    });

    it('reads a block table said to be longer than what lies before the header', () => {
        // 16,384 entries said: the table runs through the header and the file data, as the game reads it.
        const { bytes, at } = tablesBefore(1000, { blockEntries: 16384 });
        const a = Archive.open(bytes, { offset: at });
        assert.strictEqual(a.tables.block.entries, 16384);
        assert.strictEqual(a.tables.block.read, Math.floor((bytes.length - a.tables.block.start) / 16), 'cut where the data ends');
        readsAll(a);
    });

    it('is found by the scan too when its header is at a 512-byte boundary', () => {
        const { bytes, at } = tablesBefore(1000, { headerAt512: true });
        assert.strictEqual(at % 512, 0);
        const a = Archive.open(bytes);
        assert.strictEqual(a.start, at);
        readsAll(a);
    });

    it('passes over a fake header whose tables lie outside the data, and says why when there is no other', () => {
        const { bytes, at } = tablesBefore(1000, { headerAt512: true });
        // A fake header at offset 512, inside the "program": its tables 1 GB on.
        const fake = new DataView(bytes.buffer);
        fake.setUint32(512, 0x1a51504d, true);
        fake.setUint32(516, 32, true);
        fake.setUint32(520, 0, true);
        fake.setUint16(524, 0, true);
        fake.setUint16(526, 3, true);
        fake.setUint32(528, 0x40000000, true);
        fake.setUint32(532, 0x40000000, true);
        fake.setUint32(536, 16, true);
        fake.setUint32(540, 16, true);
        assert.ok(512 < at);
        assert.strictEqual(Archive.open(bytes).start, at);
        // Named exactly, the fake is refused.
        assert.throws(() => Archive.open(bytes, { offset: 512 }), (e: unknown) => e instanceof MpqError && e.kind === 'Corrupted');
        // Alone, the scan says the fake's trouble.
        assert.throws(() => Archive.open(bytes.slice(0, at)), (e: unknown) => e instanceof MpqError && e.kind === 'Corrupted' && /extends beyond/.test(e.message));
    });

    it('cannot reach the tables from a slice that starts at the header', () => {
        const { bytes, at } = tablesBefore(1000);
        assert.throws(() => Archive.open(bytes.subarray(at)), (e: unknown) => e instanceof MpqError && e.kind === 'Corrupted');
    });

    it('refuses an offset with no header there', () => {
        const { bytes, at } = tablesBefore(1000);
        assert.throws(() => Archive.open(bytes, { offset: at + 4 }), (e: unknown) => e instanceof MpqError && e.kind === 'NoHeader');
        assert.throws(() => Archive.open(bytes, { offset: bytes.length }), (e: unknown) => e instanceof MpqError && e.kind === 'NoHeader');
    });

    it('carries its members into a rewrite', () => {
        const { bytes, at } = tablesBefore(1000);
        const a = Archive.open(bytes, { offset: at });
        const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries(), listfile: false });
        for (const m of a.members()) c.addStored(m);
        readsAll(Archive.open(c.write()));
    });

    it('reads a hash table cut by the end of the data as far as it goes, the rest empty slots', () => {
        const orig = normal();
        const h = readFileHeader(new DataView(orig.buffer, orig.byteOffset, orig.byteLength), 0);
        // The hash table last in the file, then the file cut in the middle of it.
        const hash = orig.slice(h.hashTableOffset, h.hashTableOffset + h.hashTableEntries * 16);
        const block = orig.slice(h.blockTableOffset, h.blockTableOffset + h.blockTableEntries * 16);
        const first = Math.min(h.hashTableOffset, h.blockTableOffset);
        const kept = h.hashTableEntries / 2;
        const out = new Uint8Array(first + block.length + kept * 16);
        out.set(orig.subarray(0, first));
        out.set(block, first);
        out.set(hash.subarray(0, kept * 16), first + block.length);
        const w = new DataView(out.buffer);
        w.setUint32(20, first, true);
        w.setUint32(16, first + block.length, true);
        const whole = Archive.open(orig);
        const a = Archive.open(out);
        assert.deepStrictEqual(a.tables.hash, { start: first + block.length, entries: h.hashTableEntries, read: kept });
        assert.strictEqual(a.hashEntries().length, h.hashTableEntries);
        let found = 0, lost = 0;
        for (const n of ['arr\\units.dat', 'rez\\stat_txt.tbl', 'readme.txt']) {
            const slot = whole.slotOf(n)!;
            if (slot < kept) { assert.deepStrictEqual(a.readFile(n), whole.readFile(n)); found++; }
            else { assert.strictEqual(a.fileInfo(n), null, `${n} is in the lost half: not found, not misread`); lost++; }
        }
        assert.strictEqual(found + lost, 3);
    });
});

describe('two neutral entries for one name', () => {
    it('reads the later in probe order, as storm does, past a readable decoy at the home slot', () => {
        const c = new Creator({ sectorSize: 4096, listfile: false });
        c.addFile('arr\\units.dat', UNITS, { compress: 'pkware' });
        c.addFile('junk.bin', enc('a decoy with bytes'));
        const bytes = c.write();
        const a = Archive.open(bytes);
        const entries = a.hashEntries();
        const name = 'arr\\units.dat';
        const key = computeHashKey(name);
        const home = key.index & (entries.length - 1);
        const real = entries[a.slotOf(name)!];
        assert.strictEqual(a.slotOf(name), home);
        const next = (home + 1) & (entries.length - 1);
        assert.strictEqual(entries[next].blockIndex, 0xffffffff, 'the slot after home is free in this layout');
        // Home: junk.bin's block under the name, neutral; next: the real entry, neutral.
        const decoy: HashEntry = { hashA: key.hashA, hashB: key.hashB, locale: 0, platform: 0, blockIndex: entries[a.slotOf('junk.bin')!].blockIndex };
        entries[home] = decoy;
        entries[next] = { ...real };
        const out = bytes.slice();
        const h = readFileHeader(new DataView(out.buffer), 0);
        out.set(writeHashTable(entries), h.hashTableOffset);
        const b = Archive.open(out);
        assert.strictEqual(b.slotOf(name), next);
        assert.deepStrictEqual(b.readFile(name), UNITS);
        // A locale asked for is still taken at its first entry.
        assert.strictEqual(b.slotOf(name, { locale: 0 }), home);
        // A rewrite carries the real one.
        const ours = b.members().filter(m => m.hash.hashA === key.hashA && m.hash.hashB === key.hashB);
        assert.strictEqual(ours.length, 1);
        assert.strictEqual(ours[0].slot, next);
    });
});

describe('a table no archive has', () => {
    it('refuses a header whose table would be 256 MB or more, rather than making room for it', () => {
        for (const field of [24, 28]) {
            const bytes = normal();
            new DataView(bytes.buffer).setUint32(field, 0x40000000, true);
            assert.throws(() => Archive.open(bytes, { offset: 0 }), (e: unknown) => e instanceof MpqError && e.kind === 'Corrupted');
            assert.throws(() => Archive.open(bytes), (e: unknown) => e instanceof MpqError && e.kind === 'Corrupted');
        }
    });
});
