/**
 * MPQ error types.
 */

export type MpqErrorKind =
    | 'NoHeader'
    | 'IoError'
    | 'UnsupportedVersion'
    | 'Corrupted'
    | 'FileNotFound'
    | 'UnsupportedCompression'
    /** A stored member cannot be carried into the archive being written (see `Creator.addStored`). */
    | 'InvalidMember'
    /** The hash table has no free slot for a file being added. */
    | 'HashTableFull';

export class MpqError extends Error {
    public readonly kind: MpqErrorKind;
    public readonly detail?: string;

    constructor(kind: MpqErrorKind, detail?: string) {
        super(detail ? `${kind}: ${detail}` : kind);
        this.kind = kind;
        this.detail = detail;
        this.name = 'MpqError';
    }
}
