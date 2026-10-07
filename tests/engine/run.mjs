// Renders real RAW files through the GPU pipeline in headless Chromium and writes PNGs for inspection.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const out = path.join(root, 'tests', 'output');
fs.mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 2000)); });
page.on('pageerror', e => console.log('pageerror:', e.message.slice(0, 3000)));
await page.goto('http://localhost:5199/engine-harness.html');
await page.waitForFunction(() => window.harnessReady, null, { timeout: 60000 });

const save = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));
const scenarios = JSON.parse(process.argv[2] ?? '[]');
const file = process.argv[3] ?? '/@fs' + path.join(root, 'tests/fixtures/sample.nef');
const info = await page.evaluate(f => window.harness.loadRaw(f), file);
console.log('decoded', JSON.stringify(info));
for (const s of scenarios.length ? scenarios : [{ name: 'default', patch: {} }]) {
  const r = await page.evaluate(({ patch }) => {
    const e = window.harness.defaultEdit(true);
    const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) merge(a[k], b[k]); else a[k] = b[k]; } };
    merge(e, patch);
    return window.harness.render(e, 0.3);
  }, s);
  save(`${s.name}.png`, r.url);
  console.log(s.name, r.w + 'x' + r.h, r.ms.toFixed(1) + 'ms', 'mean', r.mean.map(v => v.toFixed(1)).join(','));
}
await browser.close();
await server.close();
