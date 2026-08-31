/**
 * MPQ error types.
 */

export type MpqErrorKind =
    | 'NoHeader'
    | 'IoError'
    | 'UnsupportedVersion'
    | 'Corrupted'
    | 'FileNotFound'
    | 'UnsupportedCompression';

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
