/**
 * mopaq - A JavaScript/TypeScript library for reading and creating MPQ (MoPaQ) archives.
 *
 * @packageDocumentation
 */
export { Archive } from './archive';
export { Creator } from './creator';
export { MpqError } from './error';

export type { FileOptions, CreatorOptions } from './creator';
export type { FileInfo, StoredMember } from './archive';
export type { CompressionMethod } from './compression';
export { explode, implode } from './pkware';
export type { ImplodeOptions } from './pkware';
export type { MpqErrorKind } from './error';

// Re-export types for advanced usage
export type { FileHeader } from './header';
export type { HashEntry, BlockEntry } from './table';
