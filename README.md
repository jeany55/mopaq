# mpq-js

A JavaScript/TypeScript library for reading and creating **MPQ (MoPaQ)** archive files — the format used by Blizzard Entertainment games (Warcraft III, StarCraft, Diablo II, etc.).

## Features

- **Read** MPQ v1 archives — extract files by name
- **Create** MPQ v1 archives — add files with optional compression and encryption
- **List files** via the embedded `(listfile)`
- **Full TypeScript types** with CommonJS and ESM support
- **Zero runtime dependencies** — uses only Node.js built-in `zlib`
- Supports zlib compression (read/write) and encrypted files with key adjustment

## Installation

```bash
npm install mpq-js
```

## Usage

### Reading an MPQ archive

```typescript
import { Archive } from 'mpq-js';
import * as fs from 'fs';

const data = fs.readFileSync('game.w3x');
const archive = Archive.open(data);

// List all files
const files = archive.files();
console.log(files); // ['war3map.j', 'war3map.w3e', ...]

// Extract a file
const fileData = archive.readFile('war3map.j');
fs.writeFileSync('war3map.j', fileData);
```

### Creating an MPQ archive

```typescript
import { Creator } from 'mpq-js';
import * as fs from 'fs';

const creator = new Creator();

// Add files with various options
creator.addFile('readme.txt', Buffer.from('Hello, World!'));
creator.addFile('data/config.ini', Buffer.from('[settings]\nkey=value'), {
  compress: true,
});
creator.addFile('scripts/main.j', Buffer.from('function main() {}'), {
  compress: true,
  encrypt: true,
  adjustKey: true,
});

// Write the archive
const archive = creator.write();
fs.writeFileSync('output.mpq', archive);
```

### Async API

Every method has a native `Promise`-based async counterpart that uses non-blocking zlib under the hood:

```typescript
import { Archive, Creator } from 'mpq-js';
import * as fs from 'fs/promises';

// Create asynchronously
const creator = new Creator();
creator.addFile('data.txt', Buffer.from('async content'), { compress: true });
const archiveBuf = await creator.writeAsync();
await fs.writeFile('output.mpq', archiveBuf);

// Read asynchronously
const data = await fs.readFile('game.w3x');
const archive = await Archive.openAsync(data);
const files = await archive.filesAsync();
const fileData = await archive.readFileAsync('war3map.j');
```

### Error handling

```typescript
import { Archive, MpqError } from 'mpq-js';

try {
  const archive = Archive.open(someData);
  const file = archive.readFile('missing.txt');
} catch (err) {
  if (err instanceof MpqError) {
    switch (err.kind) {
      case 'NoHeader':     // No valid MPQ header found
      case 'FileNotFound': // File not in the archive
      case 'Corrupted':    // Data integrity failure
      case 'UnsupportedVersion': // MPQ version not supported
      case 'UnsupportedCompression': // Compression method not supported
        console.error(err.message);
        break;
    }
  }
}
```

## API

### `Archive`

| Method | Description |
|--------|-------------|
| `Archive.open(data: Uint8Array \| Buffer): Archive` | Open an MPQ archive from a buffer (sync) |
| `Archive.openAsync(data: Uint8Array \| Buffer): Promise<Archive>` | Open an MPQ archive from a buffer (async) |
| `archive.readFile(name: string): Uint8Array` | Extract a file by name (sync) |
| `archive.readFileAsync(name: string): Promise<Uint8Array>` | Extract a file by name (async, non-blocking zlib) |
| `archive.files(): string[] \| null` | List files via `(listfile)` (sync) |
| `archive.filesAsync(): Promise<string[] \| null>` | List files via `(listfile)` (async) |
| `archive.start: number` | Byte offset of archive start |
| `archive.end: number` | Byte offset of archive end |
| `archive.size: number` | Archive size in bytes |

### `Creator`

| Method | Description |
|--------|-------------|
| `new Creator(sectorSize?: number)` | Create a new archive builder (default sector: 65536) |
| `creator.addFile(name, data, options?)` | Stage a file for inclusion |
| `creator.write(): Uint8Array` | Build and return the complete archive (sync) |
| `creator.writeAsync(): Promise<Uint8Array>` | Build and return the complete archive (async, non-blocking zlib) |

### `FileOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `compress` | `boolean` | `false` | Compress file data with zlib |
| `encrypt` | `boolean` | `false` | Encrypt file data |
| `adjustKey` | `boolean` | `false` | Adjust encryption key by file offset/size |

## Format Support

- **MPQ Version 1** (v0 format_version) — the format used by Warcraft III and earlier titles
- **Compression**: zlib (read/write)
- **Encryption**: Full MPQ encryption with optional key adjustment
- **Sector-based storage** with configurable sector size

## License

MIT
