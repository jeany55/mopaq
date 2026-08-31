/**
 * mopaq - A JavaScript/TypeScript library for reading and creating MPQ (MoPaQ) archives.
 *
 * @packageDocumentation
 */
export { Archive } from './archive';
export { Creator } from './creator';
export { MpqError } from './error';

export type { FileOptions } from './creator';
export type { MpqErrorKind } from './error';

// Re-export types for advanced usage
export type { FileHeader } from './header';
export type { HashEntry, BlockEntry } from './table';
