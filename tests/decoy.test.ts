/**
 * One name in several hash slots: a locale twin, or a decoy in front of the real entry —
 * an empty block, or one pointing outside the archive — for readers that take the first
 * match. `readFile` / `fileInfo` / `slotOf` pick the readable one; `members()` carries
 * only that one into a rewrite.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Archive, Creator } from '../src/index';
import { readFileHeader } from '../src/header';
import { computeHashKey, writeHashTable, readBlockTable, writeBlockTable, type HashEntry, type BlockEntry } from '../src/table';
import { MPQ_FILE_EXISTS } from '../src/consts';

const enc = (s: string) => new TextEncoder().encode(s);
const SCENARIO = 'staredit\\scenario.chk';
const REAL = enc('TYPE\x04\x00\x00\x00RAWB');

/**
 * A map whose scenario sits twice in the hash table: `first` at its home slot, the other
 * right after it in the probe chain. Each twin names a block: the scenario's own, or a
 * `decoy` block the test describes.
 */
function twins(first: 'decoy' | 'real', decoy: Partial<BlockEntry> | 'plain', locales: [number, number]): Uint8Array {
    const c = new Creator({ sectorSize: 4096, listfile: false });
    c.addFile(SCENARIO, REAL, { compress: 'pkware' });
    c.addFile('plain.bin', enc('plain'));
    const bytes = c.write();
    const a = Archive.open(bytes);
    const entries = a.hashEntries();
    const realSlot = a.slotOf(SCENARIO)!;
    const real = entries[realSlot];
    const key = computeHashKey(SCENARIO);
    const home = key.index & (entries.length - 1);
    assert.strictEqual(realSlot, home, 'the test expects the scenario at its home slot');
    // The decoy's block is a new entry at the end of the block table.
    const header = readFileHeader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0);
    const blockBytes = header.blockTableEntries * 16;
    const decoyBlock: BlockEntry = { filePos: 32, compressedSize: 0, uncompressedSize: 0, flags: MPQ_FILE_EXISTS, ...(decoy === 'plain' ? {} : decoy) };
    const out = new Uint8Array(bytes.length + 16);
    out.set(bytes);
    // Block table: rewrite with the extra entry, in place, plus 16 bytes at the end of the file.
    const blocks = readBlockTable(bytes.subarray(header.blockTableOffset, header.blockTableOffset + blockBytes), header.blockTableEntries);
    blocks.push(decoyBlock);
    out.set(writeBlockTable(blocks), header.blockTableOffset);
    // Header: one more block entry, and the archive is 16 bytes longer.
    const view = new DataView(out.buffer);
    view.setUint32(8, header.archiveSize + 16, true);
    view.setUint32(28, header.blockTableEntries + 1, true);
    // 'plain' makes the twin a readable file of its own — plain.bin's block under the scenario's name.
    const decoyEntry: HashEntry = { hashA: key.hashA, hashB: key.hashB, platform: 0, locale: 0, blockIndex: decoy === 'plain' ? entries[a.slotOf('plain.bin')!].blockIndex : header.blockTableEntries };
    const next = (home + 1) & (entries.length - 1);
    assert.ok(entries[next].blockIndex === 0xFFFFFFFF, 'the slot after home is free in this layout');
    const [a0, a1] = first === 'decoy' ? [decoyEntry, real] : [real, decoyEntry];
    entries[home] = { ...a0, locale: locales[0] };
    entries[next] = { ...a1, locale: locales[1] };
    out.set(writeHashTable(entries), header.hashTableOffset);
    return out;
}

describe('a name in several hash slots', () => {
    it('reads past an empty decoy in front of the real entry', () => {
        const a = Archive.open(twins('decoy', {}, [0, 0x409]));
        assert.deepStrictEqual(a.readFile(SCENARIO), REAL);
        assert.strictEqual(a.fileInfo(SCENARIO)!.uncompressedSize, REAL.length);
    });

    it('reads past a decoy whose block points outside the archive', () => {
        const a = Archive.open(twins('decoy', { filePos: 0x7fffff00, compressedSize: 100, uncompressedSize: 100 }, [0, 0x409]));
        assert.deepStrictEqual(a.readFile(SCENARIO), REAL);
    });

    it('still reads the real entry when it comes first', () => {
        const a = Archive.open(twins('real', {}, [0x409, 0]));
        assert.deepStrictEqual(a.readFile(SCENARIO), REAL);
    });

    it('prefers the locale asked for, then the neutral one, when both twins are readable', () => {
        // Home slot: plain.bin's bytes under the scenario's name as en-US; next slot: the real scenario, neutral.
        const a = Archive.open(twins('decoy', 'plain', [0x409, 0]));
        assert.deepStrictEqual(a.readFile(SCENARIO), REAL);
        assert.deepStrictEqual(a.readFile(SCENARIO, { locale: 0x409 }), enc('plain'));
        assert.deepStrictEqual(a.readFile(SCENARIO, { locale: 0x412 }), REAL);
        // Neither asked for nor neutral: the first in probe order.
        const b = Archive.open(twins('decoy', 'plain', [0x409, 0x412]));
        assert.deepStrictEqual(b.readFile(SCENARIO), enc('plain'));
        assert.deepStrictEqual(b.readFile(SCENARIO, { locale: 0x412 }), REAL);
    });

    it('carries one member for the name into a rewrite, not the decoy', () => {
        const a = Archive.open(twins('decoy', {}, [0, 0x409]));
        const members = a.members();
        assert.strictEqual(members.length, 2, 'scenario and plain.bin');
        const c = new Creator({ sectorSize: a.sectorSize, hashTable: a.hashEntries(), listfile: false });
        for (const m of members) c.addStored(m);
        const b = Archive.open(c.write());
        assert.deepStrictEqual(b.readFile(SCENARIO), REAL);
        assert.deepStrictEqual(b.readFile('plain.bin'), enc('plain'));
        assert.strictEqual(b.members().length, 2);
    });
});

describe('a map written by eudplib', () => {
    // eudplib writes the scenario twice: locale 0 → an empty block, locale 0x409 → the real one.
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'eudplib-decoy.scx')));

    it('opens to the real scenario', () => {
        const a = Archive.open(bytes);
        const chk = a.readFile(SCENARIO);
        assert.strictEqual(chk.length, 613420);
        assert.strictEqual(new TextDecoder().decode(chk.subarray(0, 4)), 'VER ');
        assert.strictEqual(a.fileInfo(SCENARIO)!.uncompressedSize, 613420);
        assert.strictEqual(a.hashEntries()[a.slotOf(SCENARIO)!].locale, 0x409);
    });

    it('lists the scenario once among its members', () => {
        const a = Archive.open(bytes);
        const key = computeHashKey(SCENARIO);
        const scenarioMembers = a.members().filter(m => m.hash.hashA === key.hashA && m.hash.hashB === key.hashB);
        assert.strictEqual(scenarioMembers.length, 1);
        assert.strictEqual(scenarioMembers[0].block.uncompressedSize, 613420);
    });
});
