// Copies WASM decoders into public/vendor so they are served as-is (they spawn their own pthread workers).
import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dest = path.join(root, 'public', 'vendor', 'libraw');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['worker.js', 'libraw.js', 'libraw.wasm']) fs.copyFileSync(path.join(root, 'node_modules', 'libraw-wasm', 'dist', f), path.join(dest, f));
fs.writeFileSync(path.join(dest, 'LICENSE.txt'), 'LibRaw-Wasm (ISC) — https://github.com/ybouane/LibRaw-Wasm\nLibRaw (LGPL-2.1 / CDDL-1.0) — https://www.libraw.org\n');
console.log('vendor decoders copied');
