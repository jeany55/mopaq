/**
 * Guards the "runs anywhere" promise: the library must not reach for Node-only
 * built-ins or globals. Browsers, Deno, Bun and edge runtimes have none of them,
 * and a single stray `import 'node:zlib'` breaks every non-Node consumer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.join(__dirname, '..', 'src');

const sourceFiles = fs
    .readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({ name: f, code: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }));

/** Strip comments so documentation mentioning `Buffer` doesn't trip the scan. */
function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('universal (non-Node) compatibility', () => {
    it('finds source files to scan', () => {
        assert.ok(sourceFiles.length > 0, 'no source files discovered');
    });

    it('imports no Node.js built-in modules', () => {
        const builtins = /from\s+['"](node:[^'"]+|zlib|util|fs|path|crypto|buffer|stream|os|worker_threads)['"]/g;
        for (const { name, code } of sourceFiles) {
            const hits = [...stripComments(code).matchAll(builtins)].map(m => m[1]);
            assert.deepStrictEqual(hits, [], `${name} imports Node built-in(s): ${hits.join(', ')}`);
        }
    });

    it('references no Node-only globals', () => {
        for (const { name, code } of sourceFiles) {
            const body = stripComments(code);
            for (const global of ['Buffer', 'process', '__dirname', '__filename']) {
                const hit = new RegExp(`\\b${global}\\b`).test(body);
                assert.ok(!hit, `${name} references the Node-only global \`${global}\``);
            }
        }
    });
});
