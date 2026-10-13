/**
 * MPQ IMA ADPCM decompression (compression bits 0x40 mono and 0x80 stereo).
 *
 * This is how Blizzard's archives store 16-bit PCM sound: each sample becomes one byte
 * saying how far it moved from the last one, in units of a step that widens and narrows
 * with the signal. An archive applies it sector by sector, and then packs the bytes with
 * Huffman (`huffman.ts`). The first sector of a sound, which holds the WAV header, is
 * stored another way (plainly or with PKWARE in StarCraft's archives), so the header
 * comes out exact and the samples after it are the only lossy part.
 *
 * A sector is: a zero byte, a byte giving the shift that sets how coarse the smallest
 * move is, the first sample of each channel as it is, then one byte per sample, the
 * channels taking turns. Two byte values are not samples: 0x80 repeats the last sample
 * and narrows the step, 0x81 widens the step by eight places and yields nothing.
 *
 * The decoding order and the two tables are those of StormLib's `adpcm.cpp`, copyright
 * (c) Ladislav Zezula, MIT licence — see THIRD-PARTY-NOTICES.md.
 */

const INITIAL_STEP_INDEX = 0x2c;
const MAX_STEP_INDEX = 88;

/** How the step index moves for an encoded byte, by its low five bits. */
const NEXT_STEP = [
    -1, 0, -1, 4, -1, 2, -1, 6,
    -1, 1, -1, 5, -1, 3, -1, 7,
    -1, 1, -1, 5, -1, 3, -1, 7,
    -1, 2, -1, 4, -1, 6, -1, 8,
];

/** The step for each index: the standard IMA table. */
const STEP_SIZE = [
    7, 8, 9, 10, 11, 12, 13, 14,
    16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658,
    724, 796, 876, 963, 1060, 1166, 1282, 1411,
    1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
    3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
    7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

/**
 * Decompress an MPQ ADPCM sector to 16-bit little-endian PCM.
 * @param data - The sector (after any Huffman stage)
 * @param maxSize - The most bytes it can decode to
 * @param channels - 1 for mono, 2 for stereo
 */
export function adpcmDecompress(data: Uint8Array, maxSize: number, channels: 1 | 2): Uint8Array {
    const out = new Uint8Array(maxSize);
    let length = 0;
    /** False when there is no room left for a sample. */
    const write = (sample: number): boolean => {
        if (maxSize - length < 2) return false;
        out[length++] = sample & 0xff;
        out[length++] = (sample >> 8) & 0xff;
        return true;
    };
    const done = (): Uint8Array => (length === maxSize ? out : out.subarray(0, length));

    if (data.length < 2) return done();
    const shift = data[1];
    let at = 2;

    const predicted = [0, 0];
    const stepIndex = [INITIAL_STEP_INDEX, INITIAL_STEP_INDEX];
    for (let c = 0; c < channels; c++) {
        if (data.length - at < 2) return done();
        // A signed 16-bit sample.
        const first = ((data[at] | (data[at + 1] << 8)) << 16) >> 16;
        at += 2;
        predicted[c] = first;
        if (!write(first)) return done();
    }

    let channel = channels - 1;
    while (at < data.length) {
        const encoded = data[at++];
        channel = (channel + 1) % channels;

        if (encoded === 0x80) {
            if (stepIndex[channel] !== 0) stepIndex[channel]--;
            if (!write(predicted[channel])) break;
        } else if (encoded === 0x81) {
            stepIndex[channel] = Math.min(stepIndex[channel] + 8, MAX_STEP_INDEX);
            // Nothing was produced: the next byte is for this same channel.
            channel = (channel + 1) % channels;
        } else {
            const index = stepIndex[channel];
            const step = STEP_SIZE[index];
            let difference = step >> shift;
            if (encoded & 0x01) difference += step;
            if (encoded & 0x02) difference += step >> 1;
            if (encoded & 0x04) difference += step >> 2;
            if (encoded & 0x08) difference += step >> 3;
            if (encoded & 0x10) difference += step >> 4;
            if (encoded & 0x20) difference += step >> 5;

            // Bit 6 is the sign.
            let sample = predicted[channel];
            if (encoded & 0x40) sample = Math.max(sample - difference, -32768);
            else sample = Math.min(sample + difference, 32767);
            predicted[channel] = sample;
            if (!write(sample)) break;

            stepIndex[channel] = Math.min(Math.max(index + NEXT_STEP[encoded & 0x1f], 0), MAX_STEP_INDEX);
        }
    }
    return done();
}
