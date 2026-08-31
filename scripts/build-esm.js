// Simple script to create ESM entry point
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(distDir, 'src');
const cjsIndex = path.join(srcDir, 'index.js');
const esmIndex = path.join(distDir, 'index.mjs');
const cjsOut = path.join(distDir, 'index.js');
const dtsOut = path.join(distDir, 'index.d.ts');

// Copy CJS output to dist root
fs.copyFileSync(cjsIndex, cjsOut);
fs.copyFileSync(path.join(srcDir, 'index.d.ts'), dtsOut);

// Create ESM wrapper
fs.writeFileSync(esmIndex, `import mod from './index.js';\nexport const { Archive, Creator, FileOptions, MpqError } = mod;\nexport default mod;\n`);

console.log('ESM build complete');
