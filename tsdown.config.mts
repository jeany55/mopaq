import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    // Universal: no Node built-ins are used, so the same output runs in
    // Node, browsers, Deno, Bun and edge runtimes.
    platform: 'neutral',
    target: 'es2022',
    outDir: 'dist',
    // Pin extensions so `exports` cannot drift: .cjs = CommonJS, .mjs = ESM.
    outExtensions: ({ format }) =>
        format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.mjs', dts: '.d.mts' },
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    unbundle: false,
});
