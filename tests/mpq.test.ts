import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Archive, Creator, MpqError } from '../src/index';

describe('mopaq', () => {
    describe('Creator and Archive round-trip', () => {
        it('should create and read back a simple uncompressed file', () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Hello, MPQ!');
            creator.addFile('test.txt', content);
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('test.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should create and read back a compressed file', () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Hello, MPQ! This is a test of compression.');
            creator.addFile('test.txt', content, { compress: true });
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('test.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should create and read back an encrypted file', () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Secret data in MPQ archive');
            creator.addFile('secret.txt', content, { encrypt: true });
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('secret.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should create and read back an encrypted+compressed+adjusted file', () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Encrypted and compressed data with adjusted key');
            creator.addFile('full.txt', content, { encrypt: true, compress: true, adjustKey: true });
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('full.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should list files via (listfile)', () => {
            const creator = new Creator();
            creator.addFile('file1.txt', new TextEncoder().encode('one'));
            creator.addFile('file2.txt', new TextEncoder().encode('two'));
            creator.addFile('dir\\file3.txt', new TextEncoder().encode('three'));
            const archive = creator.write();

            const reader = Archive.open(archive);
            const files = reader.files();
            assert.ok(files !== null);
            assert.ok(files!.includes('file1.txt'));
            assert.ok(files!.includes('file2.txt'));
            assert.ok(files!.includes('dir\\file3.txt'));
        });

        it('should handle forward slash to backslash conversion', () => {
            const creator = new Creator();
            creator.addFile('dir/subdir/file.txt', new TextEncoder().encode('nested'));
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('dir\\subdir\\file.txt');
            assert.deepStrictEqual(result, new TextEncoder().encode('nested'));
        });

        it('should handle multiple files', () => {
            const creator = new Creator();
            const files = new Map<string, Uint8Array>();
            for (let i = 0; i < 50; i++) {
                const name = `file${i}.txt`;
                const content = new TextEncoder().encode(`Content of file ${i}`);
                files.set(name, content);
                creator.addFile(name, content, { compress: true });
            }
            const archive = creator.write();

            const reader = Archive.open(archive);
            for (const [name, expected] of files) {
                const result = reader.readFile(name);
                assert.deepStrictEqual(result, expected);
            }
        });

        it('should handle large files spanning multiple sectors', () => {
            const creator = new Creator();
            // Create a file larger than the default sector size (65536)
            const content = new Uint8Array(200000);
            for (let i = 0; i < content.length; i++) {
                content[i] = i % 256;
            }
            creator.addFile('large.bin', content, { compress: true });
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('large.bin');
            assert.deepStrictEqual(result, content);
        });

        it('should handle empty files', () => {
            const creator = new Creator();
            creator.addFile('empty.txt', new Uint8Array(0));
            const archive = creator.write();

            const reader = Archive.open(archive);
            const result = reader.readFile('empty.txt');
            assert.strictEqual(result.length, 0);
        });
    });

    describe('Error handling', () => {
        it('should throw NoHeader for invalid data', () => {
            assert.throws(
                () => Archive.open(new Uint8Array(100)),
                (err: unknown) => err instanceof MpqError && err.kind === 'NoHeader',
            );
        });

        it('should throw FileNotFound for missing files', () => {
            const creator = new Creator();
            creator.addFile('exists.txt', new TextEncoder().encode('data'));
            const archive = creator.write();

            const reader = Archive.open(archive);
            assert.throws(
                () => reader.readFile('missing.txt'),
                (err: unknown) => err instanceof MpqError && err.kind === 'FileNotFound',
            );
        });
    });

    describe('Archive properties', () => {
        it('should report correct start, end, and size', () => {
            const creator = new Creator();
            creator.addFile('test.txt', new TextEncoder().encode('data'));
            const archive = creator.write();

            const reader = Archive.open(archive);
            assert.strictEqual(reader.start, 0);
            assert.ok(reader.size > 0);
            assert.strictEqual(reader.end, reader.start + reader.size);
        });
    });

    describe('Async API', () => {
        it('should create and read back a file using async methods', async () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Async MPQ test!');
            creator.addFile('async.txt', content, { compress: true });
            const archiveBuf = await creator.writeAsync();

            const reader = await Archive.openAsync(archiveBuf);
            const result = await reader.readFileAsync('async.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should list files asynchronously', async () => {
            const creator = new Creator();
            creator.addFile('a.txt', new TextEncoder().encode('a'));
            creator.addFile('b.txt', new TextEncoder().encode('b'));
            const archiveBuf = await creator.writeAsync();

            const reader = await Archive.openAsync(archiveBuf);
            const files = await reader.filesAsync();
            assert.ok(files !== null);
            assert.ok(files!.includes('a.txt'));
            assert.ok(files!.includes('b.txt'));
        });

        it('should handle encrypted+compressed files async', async () => {
            const creator = new Creator();
            const content = new TextEncoder().encode('Encrypted async data with adjusted key');
            creator.addFile('secret.txt', content, { encrypt: true, compress: true, adjustKey: true });
            const archiveBuf = await creator.writeAsync();

            const reader = await Archive.openAsync(archiveBuf);
            const result = await reader.readFileAsync('secret.txt');
            assert.deepStrictEqual(result, content);
        });

        it('should handle large files spanning multiple sectors async', async () => {
            const creator = new Creator();
            const content = new Uint8Array(200000);
            for (let i = 0; i < content.length; i++) {
                content[i] = i % 256;
            }
            creator.addFile('large.bin', content, { compress: true });
            const archiveBuf = await creator.writeAsync();

            const reader = await Archive.openAsync(archiveBuf);
            const result = await reader.readFileAsync('large.bin');
            assert.deepStrictEqual(result, content);
        });

        it('should reject with MpqError for missing files async', async () => {
            const creator = new Creator();
            creator.addFile('exists.txt', new TextEncoder().encode('data'));
            const archiveBuf = await creator.writeAsync();

            const reader = await Archive.openAsync(archiveBuf);
            await assert.rejects(
                () => reader.readFileAsync('missing.txt'),
                (err: unknown) => err instanceof MpqError && err.kind === 'FileNotFound',
            );
        });

        it('async write should produce same result as sync write', async () => {
            const creator1 = new Creator();
            const creator2 = new Creator();
            const content = new TextEncoder().encode('Identical content for both');
            creator1.addFile('test.txt', content, { compress: true });
            creator2.addFile('test.txt', content, { compress: true });

            const syncArchive = creator1.write();
            const asyncArchive = await creator2.writeAsync();

            assert.deepStrictEqual(syncArchive, asyncArchive);
        });
    });
});

describe('PKWARE archives and file descriptions', () => {
    const chk = (() => {
        const out = new Uint8Array(20000);
        for (let i = 0; i < out.length; i++) out[i] = i % 5 === 0 ? (i >> 8) & 0xff : 0;
        return out;
    })();

    it('writes PKWARE-compressed files the reader gets back', async () => {
        const creator = new Creator({ sectorSize: 4096 });
        creator.addFile('staredit\\scenario.chk', chk, { compress: 'pkware', encrypt: true });
        creator.addFile('plain.bin', chk);
        const bytes = creator.write();
        const archive = Archive.open(bytes);
        assert.deepStrictEqual(archive.readFile('staredit\\scenario.chk'), chk);
        assert.deepStrictEqual(await archive.readFileAsync('staredit\\scenario.chk'), chk);
        const info = archive.fileInfo('staredit\\scenario.chk')!;
        assert.strictEqual(info.compression, 'pkware');
        assert.strictEqual(info.encrypted, true);
        assert.strictEqual(info.compressed, true);
        assert.strictEqual(info.uncompressedSize, chk.length);
        assert.ok(info.compressedSize < chk.length);
        assert.strictEqual(archive.fileInfo('plain.bin')!.compression, 'none');
        assert.strictEqual(archive.fileInfo('missing')!, null);

        const zipped = new Creator();
        zipped.addFile('z', chk, { compress: true });
        assert.strictEqual(Archive.open(zipped.write()).fileInfo('z')!.compression, 'zlib');
        const async = new Creator();
        async.addFile('p', chk, { compress: 'pkware' });
        assert.deepStrictEqual(Archive.open(await async.writeAsync()).readFile('p'), chk);
    });

    it('can leave the listfile out and choose its compression', () => {
        const bare = new Creator({ listfile: false });
        bare.addFile('a.txt', new Uint8Array([1, 2, 3]));
        const archive = Archive.open(bare.write());
        assert.strictEqual(archive.files(), null);
        assert.deepStrictEqual(archive.readFile('a.txt'), new Uint8Array([1, 2, 3]));

        const listed = new Creator({ listfileCompress: 'pkware' });
        listed.addFile('a.txt', new Uint8Array([1, 2, 3]));
        const withList = Archive.open(listed.write());
        assert.deepStrictEqual(withList.files(), ['a.txt']);
    });
});
