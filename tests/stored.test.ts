/**
 * Carrying members across without their names: `Archive.members()` / `hashEntries()` /
 * `slotOf()` and `Creator.addStored` with `CreatorOptions.hashTable`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Archive, Creator, MpqError } from '../src/index';
import { readFileHeader } from '../src/header';
import { readBlockTable, writeBlockTable, type BlockEntry } from '../src/table';

const enc = (s: string) => new TextEncoder().encode(s);
const SCENARIO = 'staredit\\scenario.chk';
const WAV = 'staredit\\wav\\probe.wav';

/** A StarEdit-shaped map: no (listfile), the scenario plain, the sound encrypted with the adjusted key. */
function mapWithoutListfile(scenario = enc('TYPE\x04\x00\x00\x00RAWB')) {
    const c = new Creator({ sectorSize: 4096, listfile: false });
    c.addFile(SCENARIO, scenario, { compress: 'pkware' });
    c.addFile(WAV, new Uint8Array(9000).map((_, i) => i & 0xff), { compress: 'pkware', encrypt: true, adjustKey: true });
    c.addFile('plain.bin', enc('plain'));
    return c.write();
}

/** Where `name`'s block says its bytes are. */
const filePosOf = (a: Archive, name: string) => a.members().find(m => m.slot === a.slotOf(name))!.block.filePos;

/**
 * A protector's layout: `b.bin`'s block entry rewritten by `alias` so its bytes lie in
 * or over `a.bin`'s. Both members are stored raw, so either is readable from wherever
 * its block points.
 */
function sharedBytes(alias: (a: BlockEntry) => Partial<BlockEntry>) {
    const c = new Creator({ sectorSize: 4096, listfile: false });
    c.addFile(SCENARIO, enc('TYPE\x04\x00\x00\x00RAWB'));
    c.addFile('a.bin', new Uint8Array(100).map((_, i) => i));
    c.addFile('b.bin', new Uint8Array(100).fill(0xee));
    const bytes = c.write();
    const a = Archive.open(bytes);
    const header = readFileHeader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
    const at = header.blockTableOffset;
    const blocks = readBlockTable(bytes.subarray(at, at + header.blockTableEntries * 16), header.blockTableEntries);
    const index = (name: string) => blocks.findIndex(b => b.filePos === filePosOf(a, name));
    const b = index('b.bin');
    blocks[b] = { ...blocks[b], ...alias(blocks[index('a.bin')]) };
    const out = new Uint8Array(bytes);
    out.set(writeBlockTable(blocks), at);
    return out;
}

/** Every member but the scenario carried as stored; the scenario written anew. */
function rewrite(bytes: Uint8Array, scenario: Uint8Array) {
    const a = Archive.open(bytes);
    const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries() });
    const skip = a.slotOf(SCENARIO);
    for (const m of a.members()) if (m.slot !== skip) c.addStored(m);
    c.addFile(SCENARIO, scenario, { compress: 'pkware' });
    return c.write();
}

describe('stored members', () => {
    it('lists every member the hash table names, listfile or not', () => {
        const a = Archive.open(mapWithoutListfile());
        assert.strictEqual(a.files(), null);
        const members = a.members();
        assert.strictEqual(members.length, 3);
        for (const m of members) {
            assert.strictEqual(m.sectorSize, 4096);
            assert.strictEqual(m.data.length, m.block.compressedSize);
        }
        const slot = a.slotOf(SCENARIO);
        assert.ok(slot !== null && members.some(m => m.slot === slot));
        assert.strictEqual(a.slotOf('nothing.here'), null);
    });

    it('carries an unnamed encrypted member into a rewritten archive, readable by its name', () => {
        const original = Archive.open(mapWithoutListfile());
        const out = rewrite(original.rawData, enc('TYPE\x04\x00\x00\x00RAWS'));
        const b = Archive.open(out);

        assert.deepStrictEqual(b.readFile(SCENARIO), enc('TYPE\x04\x00\x00\x00RAWS'));
        assert.deepStrictEqual(b.readFile(WAV), original.readFile(WAV));
        assert.deepStrictEqual(b.readFile('plain.bin'), enc('plain'));
        // The stored member sits where it was, with its block entry as it was.
        assert.deepStrictEqual(b.fileInfo(WAV), { ...original.fileInfo(WAV)! });
        // The listfile names only what was added by name.
        assert.deepStrictEqual(b.files(), [SCENARIO]);
        assert.strictEqual(b.members().length, 4);
    });

    it('writes the same archive from write and writeAsync', async () => {
        const src = mapWithoutListfile();
        const a = Archive.open(src);
        const make = () => {
            const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries(), listfile: false });
            for (const m of a.members()) if (m.slot !== a.slotOf(SCENARIO)) c.addStored(m);
            c.addFile(SCENARIO, enc('new'), { compress: 'pkware', encrypt: true });
            return c;
        };
        assert.deepStrictEqual(await make().writeAsync(), make().write());
    });

    it('reuses the gap the old scenario left, so the archive does not grow every save', () => {
        // Stored raw so the sizes mean something: a 20000-byte scenario followed by two
        // other members, rewritten with a 10000-byte one and no listfile either time.
        const big = new Uint8Array(20000).map((_, i) => (i * 7) & 0xff);
        const c = new Creator({ sectorSize: 4096, listfile: false });
        c.addFile(SCENARIO, big);
        c.addFile(WAV, new Uint8Array(3000).fill(1), { encrypt: true, adjustKey: true });
        c.addFile('plain.bin', enc('plain'));
        const src = c.write();

        const a = Archive.open(src);
        const r = new Creator({ sectorSize: 4096, hashTable: a.hashEntries(), listfile: false });
        for (const m of a.members()) if (m.slot !== a.slotOf(SCENARIO)) r.addStored(m);
        r.addFile(SCENARIO, big.subarray(0, 10000));
        const out = r.write();

        // The stored members hold the tail where it was, so the file is the same size; the
        // new scenario went into the gap the old one left rather than after everything.
        assert.strictEqual(out.length, src.length);
        const b = Archive.open(out);
        assert.deepStrictEqual(b.readFile(SCENARIO), big.subarray(0, 10000));
        assert.deepStrictEqual(b.readFile(WAV), new Uint8Array(3000).fill(1));
        assert.strictEqual(b.fileInfo(SCENARIO)!.compressedSize, 10000);
        assert.deepStrictEqual(b.members().find(m => m.slot === b.slotOf(SCENARIO))!.block.filePos, 32);
    });

    it('keeps probe chains intact when some named files are dropped', () => {
        // 30 files and the listfile fill a 32-slot table; collisions are certain, so some
        // entries sit past their home slot. Drop every third by not carrying it, keep the
        // rest as stored (pretending their names are unknown), and every kept one must
        // still be found — the dropped slots read as deleted, not empty.
        const c = new Creator({ sectorSize: 4096 });
        const names = Array.from({ length: 30 }, (_, i) => `dir\\file${i}.dat`);
        names.forEach((n, i) => c.addFile(n, enc(`content ${i}`), { encrypt: i % 2 === 0, adjustKey: i % 4 === 0, compress: i % 3 === 0 }));
        const a = Archive.open(c.write());
        assert.strictEqual(a.hashEntries().length, 32);

        const dropped = new Set(names.filter((_, i) => i % 3 === 0).map(n => a.slotOf(n)));
        dropped.add(a.slotOf('(listfile)'));
        const r = new Creator({ sectorSize: 4096, hashTable: a.hashEntries() });
        for (const m of a.members()) if (!dropped.has(m.slot)) r.addStored(m);
        r.addFile('added.txt', enc('added'));
        const b = Archive.open(r.write());

        names.forEach((n, i) => {
            if (i % 3 === 0) assert.throws(() => b.readFile(n), (e: unknown) => e instanceof MpqError && e.kind === 'FileNotFound');
            else assert.deepStrictEqual(b.readFile(n), enc(`content ${i}`));
        });
        assert.deepStrictEqual(b.readFile('added.txt'), enc('added'));
        assert.deepStrictEqual(b.files(), ['added.txt']);
    });

    it('carries two members that share one block', () => {
        const src = sharedBytes(a => a);
        const original = Archive.open(src);
        assert.deepStrictEqual(original.readFile('b.bin'), original.readFile('a.bin'));

        const b = Archive.open(rewrite(src, enc('TYPE\x04\x00\x00\x00RAWS')));
        assert.deepStrictEqual(b.readFile(SCENARIO), enc('TYPE\x04\x00\x00\x00RAWS'));
        assert.deepStrictEqual(b.readFile('a.bin'), new Uint8Array(100).map((_, i) => i));
        assert.deepStrictEqual(b.readFile('b.bin'), new Uint8Array(100).map((_, i) => i));
        assert.strictEqual(filePosOf(b, 'b.bin'), filePosOf(b, 'a.bin'));
    });

    it('carries a member whose bytes lie inside another', () => {
        const src = sharedBytes(a => ({ filePos: a.filePos + 40, compressedSize: 50, uncompressedSize: 50 }));
        const b = Archive.open(rewrite(src, enc('new')));
        assert.deepStrictEqual(b.readFile('a.bin'), new Uint8Array(100).map((_, i) => i));
        assert.deepStrictEqual(b.readFile('b.bin'), new Uint8Array(50).map((_, i) => i + 40));
        // Both sit where they were, and nothing new went into the range they cover.
        assert.strictEqual(filePosOf(b, 'b.bin'), filePosOf(b, 'a.bin') + 40);
        const scenario = filePosOf(b, SCENARIO);
        assert.ok(scenario >= filePosOf(b, 'a.bin') + 100 || scenario + 3 <= filePosOf(b, 'a.bin'));
    });

    it('leaves out a block that lies past the end of the archive', () => {
        // A protector's block entry pointing near 4 GB: carried, it sized the rewrite to match.
        const src = sharedBytes(() => ({ filePos: 0xfffff000 }));
        const a = Archive.open(src);
        assert.ok(!a.members().some(m => m.slot === a.slotOf('b.bin')));

        const out = rewrite(src, enc('TYPE\x04\x00\x00\x00RAWS'));
        assert.ok(out.length <= src.length + 64, `rewrite is ${out.length} bytes from ${src.length}`);
        const b = Archive.open(out);
        assert.deepStrictEqual(b.readFile('a.bin'), new Uint8Array(100).map((_, i) => i));
        assert.strictEqual(b.slotOf('b.bin'), null);
    });

    it('does not grow the archive to reach an empty stored member', () => {
        const a = Archive.open(mapWithoutListfile());
        const [m, ...rest] = a.members();
        const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries() });
        for (const o of rest) c.addStored(o);
        c.addStored({ ...m, block: { ...m.block, filePos: 1_000_000, compressedSize: 0 }, data: new Uint8Array(0) });
        assert.ok(c.write().length < 20_000);
    });

    it('refuses members that overlap with different bytes', () => {
        const a = Archive.open(sharedBytes(a => a));
        const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries() });
        const [first, second] = a.members().filter(m => m.slot === a.slotOf('a.bin') || m.slot === a.slotOf('b.bin'));
        c.addStored(first);
        c.addStored({ ...second, data: new Uint8Array(second.data.length).fill(0xee) });
        assert.throws(() => c.write(), (e: unknown) => e instanceof MpqError && e.kind === 'InvalidMember');
    });

    it('refuses what it cannot carry', () => {
        const a = Archive.open(mapWithoutListfile());
        const [m] = a.members();

        assert.throws(() => new Creator({ sectorSize: 4096 }).addStored(m), (e: unknown) => e instanceof MpqError && e.kind === 'InvalidMember');
        assert.throws(() => new Creator({ sectorSize: 65536, hashTable: a.hashEntries() }).addStored(m), (e: unknown) => e instanceof MpqError && e.kind === 'InvalidMember');
        assert.throws(() => new Creator({ hashTable: a.hashEntries().slice(0, 3) }), (e: unknown) => e instanceof MpqError && e.kind === 'InvalidMember');

        const twice = new Creator({ sectorSize: 4096, hashTable: a.hashEntries() });
        twice.addStored(m);
        twice.addStored(m);
        assert.throws(() => twice.write(), (e: unknown) => e instanceof MpqError && e.kind === 'InvalidMember');

        const size = a.hashEntries().length;
        const full = new Creator({ sectorSize: 4096, hashTable: a.hashEntries() });
        for (let i = 0; i < size; i++) full.addFile(`f${i}`, enc('x'));
        assert.throws(() => full.write(), (e: unknown) => e instanceof MpqError && e.kind === 'HashTableFull');
    });
});
