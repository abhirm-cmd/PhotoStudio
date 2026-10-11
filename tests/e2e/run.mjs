/**
 * End-to-end test: launches the built app in Electron and drives the real
 * catalog, decoders, GPU pipeline, masks, reference grade and exporter.
 *
 *   npm run build && xvfb-run -a node tests/e2e/run.mjs
 *
 * Screenshots and exported files are written to tests/output/e2e.
 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(root, 'tests', 'output', 'e2e');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'export'), { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'photostudio-e2e-'));
const fixtures = path.join(root, 'tests', 'fixtures');
const demo = path.join(root, 'resources', 'demo');

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const PHOTO = /\.(cr2|cr3|nef|arw|raf|orf|rw2|pef|dng|jpe?g|png|tiff?|webp|heic|heif)$/i;
const originals = [fixtures, demo].flatMap(d => fs.readdirSync(d).filter(f => PHOTO.test(f)).map(f => path.join(d, f)));
const hashesBefore = new Map(originals.map(f => [f, sha(f)]));

const electronPath = (await import('electron')).default;
const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', root],
  env: { ...process.env, PHOTOSTUDIO_TEST: '1', PHOTOSTUDIO_USER_DATA: userData },
  timeout: 60_000,
});
const page = await app.firstWindow();
page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) console.log('  [renderer error]', m.text().slice(0, 300)); });
const missing = new Set();
page.on('response', r => { if (r.status() >= 400 && !missing.has(r.url())) { missing.add(r.url()); console.log(`  [${r.status()}] ${r.url().slice(0, 160)}`); } });
page.on('console', m => { if (m.type() === 'error' && m.text().startsWith('Failed to load resource')) return; });
page.on('pageerror', e => console.log('  [page error]', e.message));
await page.setViewportSize?.({ width: 1600, height: 1000 }).catch(() => {});
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const L = (fn, arg) => page.evaluate(fn, arg);
const until = async (fn, arg, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await L(fn, arg)) return Date.now() - t0; await page.waitForTimeout(400); }
  throw new Error(`Timed out waiting for ${label}`);
};

try {
  await page.waitForFunction(() => !!window.__photostudio, null, { timeout: 60_000 });
  check('App boots', true);
  await shot('01-welcome');

  /* ------------------------------------------------------------ import */
  await L(([a, b]) => window.__photostudio.api.startImport({ paths: [a, b], recursive: true, mode: 'reference', skipDuplicates: true, keywords: ['e2e'] }), [fixtures, demo]);
  const expected = originals.length;
  const tImport = await until(n => window.__photostudio.api.queryPhotos({}).then(p => p.length >= n && p.every(x => x.thumbState !== 'pending')), expected, 240_000, 'import + previews');
  const photos = await L(() => window.__photostudio.api.queryPhotos({}));
  check('Import all fixtures (RAW + JPEG)', photos.length === expected, `${photos.length}/${expected} in ${(tImport / 1000).toFixed(1)}s`);
  const bad = photos.filter(p => p.thumbState !== 'ready');
  check('Every photo has a preview', !bad.length, bad.map(p => `${p.filename}: ${p.error}`).join('; '));
  const raws = photos.filter(p => p.isRaw);
  check('RAW metadata read', raws.every(p => p.exif.make && p.width > 1000), raws.map(p => `${p.filename} ${p.exif.make} ${p.exif.model} ${p.width}×${p.height}`).join(', '));
  await L(() => window.__photostudio.useLibrary.getState().refresh());
  await page.waitForTimeout(800);
  await shot('02-library-grid');

  /* ------------------------------------------------------------ develop each RAW */
  await L(() => window.__photostudio.useApp.getState().setWorkspace('develop'));
  for (const p of photos) {
    await L(id => { window.__photostudio.useView.setState({ ready: false }); window.__photostudio.useLibrary.getState().setActive(id); }, p.id);
    try {
      const t = await until(id => { const v = window.__photostudio.useView.getState(); return window.__photostudio.host().photo?.id === id && v.ready && !!v.histo; }, p.id, 120_000, `render ${p.filename}`);
      check(`Develop renders ${p.filename}`, true, `${(t / 1000).toFixed(1)}s`);
    } catch (e) { check(`Develop renders ${p.filename}`, false, String(e.message)); }
  }
  const nef = photos.find(p => p.filename.toLowerCase().endsWith('.nef'));
  await L(id => { window.__photostudio.useView.setState({ ready: false }); window.__photostudio.useLibrary.getState().setActive(id); }, nef.id);
  await until(id => window.__photostudio.host().photo?.id === id && window.__photostudio.useView.getState().ready, nef.id, 120_000, 'NEF');
  await page.waitForTimeout(500);
  await shot('03-develop-raw');

  /* ------------------------------------------------------------ edit + persistence */
  const before = await L(() => window.__photostudio.useView.getState().histo?.mean ?? null);
  await L(() => { const d = window.__photostudio.useDevelop.getState(); d.setEdit(e => { e.exposure = 0.8; e.contrast = 25; e.vibrance = 30; }, 'E2E edit'); });
  await page.waitForTimeout(1500);
  const saved = await L(id => window.__photostudio.api.getEdit(id), nef.id);
  check('Edit is saved to the catalog', saved?.exposure === 0.8 && saved?.contrast === 25, JSON.stringify({ exposure: saved?.exposure, contrast: saved?.contrast }));
  const hist = await L(id => window.__photostudio.api.history(id), nef.id);
  check('Edit appears in history', hist.some(h => h.label === 'E2E edit'), `${hist.length} entries`);
  await shot('04-develop-edited');
  await L(() => window.__photostudio.useDevelop.getState().undo());
  await page.waitForTimeout(800);
  const undone = await L(() => window.__photostudio.useDevelop.getState().edit.exposure);
  check('Undo restores the previous state', undone === 0, `exposure ${undone}`);
  await L(() => window.__photostudio.useDevelop.getState().redo());

  /* ------------------------------------------------------------ AI enhance on a JPEG */
  const coast = photos.find(p => p.filename === 'golden-coast.jpg');
  await L(id => { window.__photostudio.useView.setState({ ready: false }); window.__photostudio.useLibrary.getState().setActive(id); }, coast.id);
  await until(id => window.__photostudio.host().photo?.id === id && window.__photostudio.useView.getState().ready && window.__photostudio.useDevelop.getState().photoId === id, coast.id, 60_000, 'coast');
  await L(() => window.__photostudio.runAutoEnhance(1));
  await page.waitForTimeout(1500);
  const enh = await L(() => window.__photostudio.useDevelop.getState().edit);
  check('AI Auto Enhance produces editable settings', Math.abs(enh.exposure) + Math.abs(enh.vibrance) + Math.abs(enh.shadows) + Math.abs(enh.highlights) > 0, `exposure ${enh.exposure}, highlights ${enh.highlights}, shadows ${enh.shadows}, vibrance ${enh.vibrance}, dehaze ${enh.effects?.dehaze}`);
  await shot('05-auto-enhance');

  /* ------------------------------------------------------------ sky mask */
  await L(() => window.__photostudio.useApp.getState().setWorkspace('masking'));
  await L(() => window.__photostudio.createMask('sky'));
  await until(() => window.__photostudio.useDevelop.getState().edit.masks.length > 0 && !document.querySelector('.mask-create .spinner'), null, 60_000, 'sky mask');
  await page.waitForTimeout(1000);
  const mask = await L(() => window.__photostudio.useDevelop.getState().edit.masks[0]);
  check('Sky mask created', mask?.components?.[0]?.type === 'ai', `${mask?.name} · ${mask?.components?.[0]?.provider}`);
  await L(() => { const d = window.__photostudio.useDevelop.getState(); d.setEdit(e => { e.masks[0].adjust.exposure = -0.8; e.masks[0].adjust.saturation = 30; }, 'Darken sky'); d.set({ maskOverlay: true }); });
  await page.waitForTimeout(1200);
  await shot('06-mask-sky-overlay');
  await L(() => window.__photostudio.useDevelop.getState().set({ maskOverlay: false }));
  await page.waitForTimeout(800);
  await shot('07-mask-sky-applied');

  /* ------------------------------------------------------------ reference grade */
  const forest = photos.find(p => p.filename === 'forest-trail.jpg');
  await L(() => window.__photostudio.useApp.getState().setWorkspace('reference'));
  await L(id => window.__photostudio.useLibrary.getState().setActive(id), forest.id);
  await until(id => window.__photostudio.useDevelop.getState().photoId === id && window.__photostudio.useView.getState().ready, forest.id, 60_000, 'forest');
  const grade = await L(async ([refPath, id]) => {
    const h = window.__photostudio;
    const ref = await h.loadReferenceImage({ kind: 'file', path: refPath });
    const photo = h.useLibrary.getState().photos.find(p => p.id === id);
    const base = h.useDevelop.getState().edit;
    const r = await h.fitGrade(photo, base, ref.stats, 'full');
    const d = (a, b) => a.q.reduce((s, v, i) => s + Math.abs(v - b.q[i]), 0) / a.q.length + Math.hypot(a.zones[3].a - b.zones[3].a, a.zones[3].b - b.zones[3].b) * 4;
    return { look: h.describeLook(ref.stats), before: d(r.target, ref.stats), after: d(r.result, ref.stats), notes: r.notes, exposure: r.edit.exposure, curve: r.edit.curve.rgb.length };
  }, [path.join(demo, 'teal-orange-reference.jpg'), forest.id]);
  check('Reference Grade moves the photo toward the reference', grade.after < grade.before * 0.8, `distance ${grade.before.toFixed(3)} → ${grade.after.toFixed(3)}; look: ${grade.look.join(', ')}; ${grade.notes.join(', ')}`);
  // Drive the actual workspace UI with a dropped reference
  await L(p => window.dispatchEvent(new CustomEvent('photostudio:reference-drop', { detail: p })), path.join(demo, 'teal-orange-reference.jpg'));
  await until(() => !!document.querySelector('.match-table'), null, 90_000, 'reference workspace fit');
  await page.waitForTimeout(1500);
  await shot('08-reference-grade');
  await page.getByRole('button', { name: 'Apply to photo' }).click();
  await page.waitForTimeout(1200);
  const applied = await L(id => window.__photostudio.api.getEdit(id), forest.id);
  check('Reference Grade applies as normal edits', !!applied && (applied.grading.shadows.sat > 0 || applied.grading.highlights.sat > 0), `shadows ${applied?.grading.shadows.hue}°/${applied?.grading.shadows.sat}, highlights ${applied?.grading.highlights.hue}°/${applied?.grading.highlights.sat}`);

  /* ------------------------------------------------------------ other workspaces */
  for (const [ws, name] of [['presets', '09-presets'], ['color', '10-color'], ['compare', '11-compare'], ['export', '12-export']]) {
    await L(w => window.__photostudio.useApp.getState().setWorkspace(w), ws);
    await page.waitForTimeout(ws === 'presets' ? 4000 : 1500);
    await shot(name);
  }

  /* ------------------------------------------------------------ export */
  const exportIds = [nef.id, coast.id, forest.id, photos.find(p => p.filename.toLowerCase() === 'sample.cr2').id];
  const exp = await L(async ([ids, dest]) => {
    const h = window.__photostudio;
    const ps = await h.api.getPhotos(ids);
    const s = { ...h.defaultExportSettings(dest), format: 'jpeg', quality: 90 };
    s.resize = { ...s.resize, mode: 'long', long: 3000, noEnlarge: true };
    const job = h.startExport(ps, s, () => {});
    return job.done;
  }, [exportIds, path.join(out, 'export')]);
  check('Export finishes', exp.phase === 'done' && exp.failed === 0, `${exp.outputs?.length} files, ${exp.failed} failed${exp.message ? `, ${exp.message}` : ''}`);
  for (const f of exp.outputs ?? []) {
    const m = await sharp(f).metadata();
    const src = photos.find(p => p.filename.replace(/\.[^.]+$/, '') === path.basename(f, '.jpg'));
    const want = Math.min(3000, Math.max(src.width, src.height)); // never enlarged
    check(`Exported ${path.basename(f)}`, Math.max(m.width, m.height) === want && !!m.icc, `${m.width}×${m.height} ${m.format}, ICC ${m.icc ? 'embedded' : 'missing'}`);
  }
  const tiff = await L(async ([id, dest]) => {
    const h = window.__photostudio;
    const ps = await h.api.getPhotos([id]);
    const s = { ...h.defaultExportSettings(dest), format: 'tiff', bitDepth: 16, colorSpace: 'adobe-rgb' };
    return h.startExport(ps, s, () => {}).done;
  }, [nef.id, path.join(out, 'export')]);
  if (tiff.outputs?.[0]) { const m = await sharp(tiff.outputs[0]).metadata(); check('Full-resolution 16-bit TIFF export', m.depth === 'ushort' && m.width >= nef.width - 64, `${m.width}×${m.height} ${m.depth}`); }
  else check('Full-resolution 16-bit TIFF export', false, tiff.message);

  /* ------------------------------------------------------------ originals untouched */
  const changed = originals.filter(f => sha(f) !== hashesBefore.get(f));
  check('Original files are never modified', !changed.length, changed.join(', '));
} catch (e) {
  check('E2E run', false, e.stack ?? String(e));
  await shot('zz-failure').catch(() => {});
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
