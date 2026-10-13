/**
 * MPQ "Huffman" decompression (compression bit 0x01).
 *
 * Blizzard's archives use it almost only on sound: a WAV is first reduced with IMA ADPCM
 * (`adpcm.ts`) and the result is then packed with this, so a StarCraft archive's sounds
 * cannot be read without both.
 *
 * It is an adaptive Huffman coder. The stream opens with one byte naming a table of
 * starting weights for the 256 byte values; the tree built from that table has two more
 * leaves, 0x100 for the end of the stream and 0x101 for "a byte not in the tree yet, its
 * eight bits follow". A new byte is added as a leaf, and the tree is rebalanced as
 * weights grow, so decoder and encoder change their trees in step. The tree's nodes are
 * also kept in one list ordered by weight, which is what the rebalancing walks.
 *
 * The method, the order of every list operation (the output depends on it exactly) and
 * the weight tables are those of StormLib's `huff.cpp`, copyright (c) Ladislav Zezula,
 * MIT licence — see THIRD-PARTY-NOTICES.md. StormLib's "quick link" cache is left out:
 * it speeds decoding up and changes nothing that is decoded.
 */
import { MpqError } from './error';

/** The list's sentinel: its `next` is the heaviest node (the root), its `prev` the lightest. */
const HEAD = 0;
/** No node. */
const NONE = -1;
/** The most nodes a tree can have: 258 leaves and their parents. */
const MAX_ITEMS = 515;
const END_OF_STREAM = 0x100;
const NEW_BYTE = 0x101;

/** Starting weights by byte value, one table per data type (the stream's first byte); the last two are always zero. */
const WEIGHTS: readonly Uint8Array[] = [
    // 0: sparse data (the tree learns every byte as it goes)
    hex(
        '0a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000020000',
    ),
    // 1: general binary data
    hex(
        '5416160d0c08060506050603040403050e0b141313090b0605040302030202020d070906060403020403030303030202' +
        '090604040404030203020202020302040803040709050303030302020203020203020202020202020201010102010202' +
        '060a0808060704030404020204020303040307070906040303020102020202020a020203020201010202020603050203' +
        '0201010101010101010101020301010102010101010101020404040709080c0201010101010101010101010102010103' +
        '040102040501010101010101020101010401010101010201010101010101010102010101010101010301010101010101' +
        '0201010101010102020101020202064b0000',
    ),
    // 2: text
    hex(
        '0000000000000000000327000023000000000000000000000000000000000000ff0101010101010102020101060e1004' +
        '060805040403030202030301010201010104020402020201010401010203030203010306040101010101010201020101' +
        '0129071612400a0a112501031710262a100123232f100607020901010101010000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
    // 3: general purpose
    hex(
        'ff0b07050b020202060202010402010309010101030401010201010102010101050101010d0101010101010101010101' +
        '020101030101010101010102010101010a04020106030201010101010301010105020304030303020101010201020303' +
        '01030101020501010403050103010303020104030a06010101010101010101010202010a020501010207021701050101' +
        '0e0101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101' +
        '060201040501010201010101020101010101010101010101010101010101010101010101010101010701010201010101' +
        '020101010101010102010101010101110000',
    ),
    // 4: 4-bit ADPCM samples
    hex(
        'fffb989a848563643e3e2222131318170000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
    // 5: 6-bit ADPCM samples
    hex(
        'fff19d9e9a9b9a9793938c8e868880827c7c7273696b5f6055564a4b404137372f2f272721211b1c1717131310100d0d' +
        '0b0b09090808070706050504040419180000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
    // 6: 3-bit stereo
    hex(
        'c3cbf541ff7bf72100000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '00000000000000000000000000000000bfccf240fd7cf722000000000000000000000000000000000000000000000000' +
        '00000000000000000000000000000000000000000000000000000000000000007a460000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
    // 7: 4-bit stereo
    hex(
        'c3d9ef3df97ce91efdabf12cfc5bfe170000000000000000000000000000000000000000000000000000000000000000' +
        '00000000000000000000000000000000bdd9ec3df57de81dfbaef02cfb5cff1800000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000000706c0000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
    // 8: 5-bit stereo
    hex(
        'bac5da33e36dd818e594da23df4ad110eeafe42cea5ade15f487e921f643fc1200000000000000000000000000000000' +
        '00000000000000000000000000000000b0c7d833e36bd618e795d823db49d011e9b2e22be85cdd15f187e720f744ff13' +
        '00000000000000000000000000000000000000000000000000000000000000005f9e0000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
        '000000000000000000000000000000000000',
    ),
];

function hex(digits: string): Uint8Array {
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
    return out;
}

/** The adaptive tree: nodes are indices into parallel arrays, index 0 being the list's sentinel. */
class Tree {
    private readonly next = new Int32Array(MAX_ITEMS + 1).fill(NONE);
    private readonly prev = new Int32Array(MAX_ITEMS + 1).fill(NONE);
    readonly value = new Int32Array(MAX_ITEMS + 1);
    private readonly weight = new Int32Array(MAX_ITEMS + 1);
    private readonly parent = new Int32Array(MAX_ITEMS + 1).fill(NONE);
    /** A parent's lighter child; the heavier one is the node before it in the list. */
    readonly childLo = new Int32Array(MAX_ITEMS + 1).fill(NONE);
    readonly byByte = new Int32Array(258).fill(NONE);
    private used = 0;

    constructor(dataType: number) {
        this.next[HEAD] = this.prev[HEAD] = HEAD;
        const table = WEIGHTS[dataType & 0x0f];
        if (!table) throw new MpqError('Corrupted', `Huffman stream names data type ${dataType & 0x0f}`);

        let max = 0;
        for (let i = 0; i < 0x100; i++) {
            if (table[i] === 0) continue;
            const item = this.create(i, table[i], true);
            this.byByte[i] = item;
            max = this.settle(item, max);
        }
        this.byByte[END_OF_STREAM] = this.create(END_OF_STREAM, 1, false);
        this.byByte[NEW_BYTE] = this.create(NEW_BYTE, 1, false);

        // Pair the nodes up from the light end of the list, each pair under a new parent.
        let lo = this.prev[HEAD];
        while (lo !== HEAD) {
            const hi = this.prev[lo];
            if (hi === HEAD) break;
            const parent = this.create(0, this.weight[hi] + this.weight[lo], true);
            this.parent[lo] = parent;
            this.parent[hi] = parent;
            this.childLo[parent] = lo;
            max = this.settle(parent, max);
            lo = this.prev[hi];
        }
    }

    /** The heaviest node, which is the root. */
    get root(): number {
        return this.next[HEAD];
    }

    /** The lightest node. */
    get last(): number {
        return this.prev[HEAD];
    }

    /** The heavier of a parent's two children. */
    childHi(parent: number): number {
        return this.prev[this.childLo[parent]];
    }

    private unlink(item: number): void {
        if (this.next[item] === NONE) return;
        this.next[this.prev[item]] = this.next[item];
        this.prev[this.next[item]] = this.prev[item];
        this.next[item] = this.prev[item] = NONE;
    }

    /** Put `item` into the list straight after `after`. */
    private link(after: number, item: number): void {
        const following = this.next[after];
        this.next[item] = following;
        this.prev[item] = after;
        this.prev[following] = item;
        this.next[after] = item;
    }

    /** From `item` towards the heavy end: the first node at least this heavy, or the sentinel. */
    private atLeast(item: number, weight: number): number {
        while (item !== HEAD) {
            if (this.weight[item] >= weight) return item;
            item = this.prev[item];
        }
        return HEAD;
    }

    /** A new node at the heavy end of the list (`heavy`) or the light end. */
    private create(value: number, weight: number, heavy: boolean): number {
        if (this.used >= MAX_ITEMS) throw new MpqError('Corrupted', 'Huffman tree outgrew its node pool');
        const item = ++this.used;
        this.link(heavy ? HEAD : this.prev[HEAD], item);
        this.value[item] = value;
        this.weight[item] = weight;
        this.parent[item] = NONE;
        this.childLo[item] = NONE;
        return item;
    }

    /** Move a node just created at the heavy end down to where its weight puts it; returns the heaviest weight so far. */
    private settle(item: number, max: number): number {
        if (this.weight[item] >= max) return this.weight[item];
        const heavier = this.atLeast(this.prev[HEAD], this.weight[item]);
        this.unlink(item);
        this.link(heavier, item);
        return max;
    }

    /** One more occurrence of a leaf: its weight and every ancestor's go up by one, nodes trading places to keep the list ordered. */
    bump(item: number): void {
        for (; item !== NONE; item = this.parent[item]) {
            this.weight[item]++;
            const heavier = this.atLeast(this.prev[item], this.weight[item]);
            const other = this.next[heavier];
            if (other === item) continue;

            // `other` takes this node's place in the list, and this node goes up beside `heavier`.
            this.unlink(other);
            this.link(item, other);
            this.unlink(item);
            this.link(heavier, item);

            // …and they trade parents, each parent's lighter-child pointer following.
            const otherParent = this.parent[other];
            const itemParent = this.parent[item];
            if (otherParent === NONE || itemParent === NONE) throw new MpqError('Corrupted', 'Huffman tree lost its shape');
            const otherWasLo = this.childLo[otherParent] === other;
            if (this.childLo[itemParent] === item) this.childLo[itemParent] = other;
            if (otherWasLo) this.childLo[otherParent] = item;
            this.parent[item] = otherParent;
            this.parent[other] = itemParent;
        }
    }

    /** A byte not seen before: the lightest leaf becomes a parent of itself (as a new leaf) and the new byte. */
    add(byte: number): void {
        const last = this.prev[HEAD];
        const moved = this.value[last];
        const hi = this.create(moved, this.weight[last], false);
        this.parent[hi] = last;
        this.byByte[moved] = hi;
        const lo = this.create(byte, 0, false);
        this.parent[lo] = last;
        this.childLo[last] = lo;
        this.byByte[byte] = lo;
        this.bump(lo);
    }
}

/**
 * Decompress an MPQ Huffman stream.
 * @param data - The stream (after the sector's compression-type byte)
 * @param maxSize - The most bytes it can decode to
 */
export function huffmanDecompress(data: Uint8Array, maxSize: number): Uint8Array {
    if (data.length === 0) throw new MpqError('Corrupted', 'empty Huffman stream');
    const dataType = data[0];
    const sparse = dataType === 0;
    const tree = new Tree(dataType);
    const out = new Uint8Array(maxSize);
    let length = 0;

    // Bits are taken from each byte lowest first.
    let at = 1;
    let bits = 0;
    let have = 0;
    const need = (count: number): void => {
        while (have < count) {
            if (at >= data.length) throw new MpqError('Corrupted', 'Huffman stream ends before its end mark');
            bits |= data[at++] << have;
            have += 8;
        }
    };

    for (;;) {
        // Down from the root: a set bit takes the heavier child.
        let item = tree.root;
        if (item === HEAD) throw new MpqError('Corrupted', 'Huffman tree is empty');
        while (tree.childLo[item] !== NONE) {
            need(1);
            item = bits & 1 ? tree.childHi(item) : tree.childLo[item];
            bits >>>= 1;
            have--;
        }
        let value = tree.value[item];
        if (value === END_OF_STREAM) break;

        if (value === NEW_BYTE) {
            need(8);
            value = bits & 0xff;
            bits >>>= 8;
            have -= 8;
            tree.add(value);
            if (!sparse) tree.bump(tree.byByte[value]);
        }

        if (length >= maxSize) break;
        out[length++] = value;
        if (sparse) tree.bump(tree.byByte[value]);
    }

    return length === maxSize ? out : out.subarray(0, length);
}
