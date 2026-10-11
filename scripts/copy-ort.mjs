// Copies the ONNX Runtime WebAssembly files into public/vendor/ort so the
// renderer can load them from the app bundle (AI masks run fully on-device).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'node_modules', 'onnxruntime-web');
const dest = path.join(root, 'public', 'vendor', 'ort');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) fs.copyFileSync(path.join(src, 'dist', f), path.join(dest, f));
fs.writeFileSync(path.join(dest, 'LICENSE.txt'), 'ONNX Runtime Web is MIT licensed. Copyright (c) Microsoft Corporation. https://github.com/microsoft/onnxruntime/blob/main/LICENSE\n');
