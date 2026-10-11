/**
 * End-to-end test: launches the built app in Electron and drives the real
 * importer, analysis (filmstrips, waveforms), GPU program monitor, editing,
 * grading, titles, transitions, mixer, project save/open and FFmpeg export.
 *
 *   npm run build && npm run media && xvfb-run -a node tests/e2e/run.mjs
 *
 * Screenshots and rendered files go to tests/output/e2e.
 */
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpegPath, ffprobePath } from '../../electron/ffpaths.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const media = path.join(root, 'tests', 'media');
const out = path.join(root, 'tests', 'output', 'e2e');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(media, 'city-1080p30.mp4'))) execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-media.mjs')], { stdio: 'inherit' });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-e2e-'));

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sources = fs.readdirSync(media).map(f => path.join(media, f));
const hashes = new Map(sources.map(f => [f, sha(f)]));

const electronPath = (await import('electron')).default;
const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', root],
  env: { ...process.env, PHOTOSTUDIO_PRO_TEST: '1', PHOTOSTUDIO_PRO_USER_DATA: userData },
  timeout: 60_000,
});
const appLog = fs.createWriteStream(path.join(out, 'electron.log'));
const appProc = app.process();
appProc.stdout?.pipe(appLog); appProc.stderr?.pipe(appLog);
const page = await app.firstWindow();
page.on('pageerror', e => console.log('  [page error]', e.message));
page.on('response', r => { if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.url().slice(0, 200)}`); });
page.on('console', m => { if (m.type() === 'error') console.log('  [renderer error]', m.text().slice(0, 300)); });
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const L = (fn, arg) => page.evaluate(fn, arg);
const until = async (fn, arg, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await L(fn, arg)) return Date.now() - t0; await page.waitForTimeout(250); }
  throw new Error(`Timed out waiting for ${label}`);
};
/** Wait until the program monitor has drawn the current frame with nothing pending. */
const settled = async (label = 'render') => {
  await until(() => { const e = window.__psp.engine(); e.invalidate(); return e.last.pending === 0 && e.last.frame === window.__psp.usePlayer.getState().frame; }, null, 20000, label);
  await page.waitForTimeout(150);
};
/** Mean RGB of the program monitor (optionally a region in 0..1 coordinates). */
const programRgb = (r = [0, 0, 1, 1]) => L(([x, y, w, h]) => {
  const c = window.__psp.engine().canvas;
  const t = document.createElement('canvas'); t.width = 64; t.height = 36;
  const g = t.getContext('2d');
  g.drawImage(c, x * c.width, y * c.height, w * c.width, h * c.height, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  let s = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
  return s.map(v => v / (d.length / 4));
}, r);
const setFrame = async f => { await L(f => { window.__psp.usePlayer.getState().pause(); window.__psp.usePlayer.getState().setFrame(f); }, f); await settled(`frame ${f}`); };
const P = () => L(() => window.__psp.useProject.getState().project);
const ffprobe = f => JSON.parse(execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).toString());
/** Mean RGB of one exported frame (scaled down like programRgb). */
const fileRgb = (f, t) => {
  const b = execFileSync(ffmpegPath(), ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=64:36:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
  const s = [0, 0, 0];
  for (let i = 0; i < b.length; i += 3) { s[0] += b[i]; s[1] += b[i + 1]; s[2] += b[i + 2]; }
  return s.map(v => v / (b.length / 3));
};
const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

try {
  await page.waitForFunction(() => !!window.__psp, null, { timeout: 60_000 });
  check('App boots', true);
  await shot('01-empty');

  /* ------------------------------------------------------------ import */
  const t0 = Date.now();
  await L(paths => window.__psp.importPaths(paths), [media]);
  await until(() => {
    const s = window.__psp; const p = s.useProject.getState().project;
    return p.media.length >= 5 && p.media.every(m => (m.kind === 'audio' || m.thumbs) && (!m.hasAudio || m.waveform)) && !Object.keys(s.useUI.getState().tasks).length;
  }, null, 120_000, 'import + analysis');
  let p = await P();
  check('Import probes every file', p.media.length === 5, p.media.map(m => `${m.name} ${m.kind} ${m.width}×${m.height} ${m.duration.toFixed(1)}s`).join('; '));
  check('Filmstrips and waveforms built', p.media.every(m => (m.kind === 'audio' || m.thumbs) && (!m.hasAudio || m.waveform)), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const byName = n => p.media.find(m => m.name === n);
  check('Portrait clip detected', byName('vertical-720x1280.mp4').width === 720 && byName('vertical-720x1280.mp4').height === 1280);
  await L(() => window.__psp.useUI.getState().setPage('media'));
  await L(id => { window.__psp.usePlayer.getState().setSource(id); window.__psp.useProject.getState().selectMedia(id); }, byName('city-1080p30.mp4').id);
  await page.waitForTimeout(1200);
  await shot('02-media-page');

  /* ------------------------------------------------------- edit: 3-point editing */
  await L(() => window.__psp.useUI.getState().setPage('edit'));
  // Source in/out, then overwrite at the playhead (the "." key)
  await L(() => window.__psp.usePlayer.setState({ sourceIn: 1, sourceOut: 5, frame: 0 }));
  await page.keyboard.press('.');
  p = await P();
  const city = p.clips.filter(c => c.mediaId === byName('city-1080p30.mp4').id);
  check('Overwrite from source places linked video + audio', city.length === 2 && city.every(c => c.duration === 120 && c.srcIn === 1) && city[0].linkId && city[0].linkId === city[1].linkId, city.map(c => `${c.trackId} ${c.start}+${c.duration}`).join(', '));
  // Bars at 4 s, then the portrait clip and the still
  await L(id => { const s = window.__psp; s.usePlayer.setState({ sourceId: id, sourceIn: 0, sourceOut: 4, frame: 120 }); s.actions.editFromSource('overwrite'); }, byName('bars-720p25.mp4').id);
  await L(id => { const s = window.__psp; s.usePlayer.setState({ sourceId: id, sourceIn: 0, sourceOut: 3, frame: 240 }); s.actions.editFromSource('overwrite'); }, byName('vertical-720x1280.mp4').id);
  await L(id => { const s = window.__psp; s.usePlayer.setState({ sourceId: id, sourceIn: null, sourceOut: null, frame: 330 }); s.actions.editFromSource('overwrite'); }, byName('still-gradient.png').id);
  // Music bed on A2 under everything: 16 s, −6 dB, faded in and out
  await L(id => {
    const s = window.__psp; const st = s.useProject.getState(); const a2 = st.project.tracks.filter(t => t.kind === 'audio')[1].id;
    st.edit('Add music', q => { const cs = s.timeline.clipsForMedia(q, id, 0, { audioTrack: a2, srcOut: 16 }); cs.forEach(c => { c.volume = -6; c.fadeIn = 30; c.fadeOut = 60; }); s.timeline.placeClips(q, cs); });
  }, byName('music-bed.mp3').id);
  p = await P();
  const end = Math.max(...p.clips.map(c => c.start + c.duration));
  check('Timeline assembled', p.clips.length === 7 && end === 480, `${p.clips.length} clips, ${end} frames`);
  await L(() => document.querySelector('button[title^="Zoom to fit"]').click());
  await setFrame(60);
  const c1 = await programRgb();
  check('Program monitor shows video (GPU)', lum(c1) > 30, `mean RGB ${c1.map(v => v.toFixed(0)).join(',')}`);
  await shot('03-edit-assembled');

  /* ------------------------------------------------- preview matches the source pixels */
  // Frame 60 is 2 s into a clip whose source in-point is 1 s → source time 3 s
  const src = fileRgb(byName('city-1080p30.mp4').path, 3);
  check('Program frame matches the source frame', diff(c1, src) < 10, `preview ${c1.map(v => v.toFixed(0))} vs file ${src.map(v => v.toFixed(0))}`);

  /* ----------------------------------------------------- portrait clip pillarboxed */
  await setFrame(270);
  const side = await programRgb([0, 0, 0.12, 1]), mid = await programRgb([0.4, 0.3, 0.2, 0.4]);
  check('Portrait clip is pillarboxed', lum(side) < 4 && lum(mid) > 10, `side ${lum(side).toFixed(1)}, centre ${lum(mid).toFixed(1)}`);

  /* ------------------------------------------------------------ razor + ripple delete */
  await setFrame(60);
  await L(() => window.__psp.useProject.getState().select([]));
  await page.keyboard.press('Control+k');
  p = await P();
  const cut = p.clips.filter(c => c.mediaId === byName('city-1080p30.mp4').id);
  check('Split at playhead (Ctrl+K) cuts every track', cut.length === 4 && cut.some(c => c.start === 60), cut.map(c => `${c.start}+${c.duration}`).join(', '));
  const music = p.clips.find(c => c.mediaId === byName('music-bed.mp3').id && c.start === 60);
  check('Razor splits the music bed too', !!music);
  await L(() => window.__psp.useProject.getState().undo());
  p = await P();
  check('Undo restores the split', p.clips.filter(c => c.mediaId === byName('city-1080p30.mp4').id).length === 2);
  await L(() => window.__psp.useProject.getState().redo());
  await L(() => window.__psp.useProject.getState().undo());

  /* ---------------------------------------------------------------- transitions */
  const barsV = (await P()).clips.filter(c => c.mediaId === byName('bars-720p25.mp4').id).find(c => c.trackId === (p.tracks.find(t => t.kind === 'video').id));
  await L(id => { window.__psp.useProject.getState().select([id]); }, barsV.id);
  await page.keyboard.press('Control+d');
  p = await P();
  check('Ctrl+D adds a cross dissolve', p.clips.find(c => c.id === barsV.id).transitionIn?.type === 'dissolve');
  await setFrame(119);
  const before = await programRgb();
  await setFrame(135);
  const during = await programRgb();
  await setFrame(152);
  const after = await programRgb();
  check('Dissolve blends outgoing and incoming', diff(during, before) > 3 && diff(during, after) > 3, `mid ${during.map(v => v.toFixed(0))}`);

  /* -------------------------------------------------------------------- titles */
  await setFrame(30);
  await L(() => window.__psp.actions.addTitle('PhotoStudio Pro'));
  await page.waitForTimeout(300);
  p = await P();
  const title = p.clips.find(c => c.kind === 'title');
  check('Title clip added on an upper track', !!title && p.tracks.findIndex(t => t.id === title.trackId) > 0);
  await page.fill('[data-testid="title-text"]', 'Golden Hour\nby PhotoStudio Pro');
  await settled('title');
  const tRgb = await programRgb([0.3, 0.38, 0.4, 0.24]);
  check('Title renders in the program monitor', lum(tRgb) > lum(c1) * 0.6, `title area luma ${lum(tRgb).toFixed(0)}`);
  await shot('04-edit-title-selected');

  /* --------------------------------------------------------------------- color */
  await L(() => window.__psp.useUI.getState().setPage('color'));
  const cityV = (await P()).clips.find(c => c.mediaId === byName('city-1080p30.mp4').id && c.trackId === p.tracks.find(t => t.kind === 'video').id);
  await L(id => window.__psp.useProject.getState().select([id]), cityV.id);
  await setFrame(90);
  const ungraded = await programRgb();
  await L(id => window.__psp.useProject.getState().edit('Grade', q => { const c = q.clips.find(x => x.id === id); c.grade.exposure = 0.8; c.grade.temperature = 45; c.grade.saturation = 130; c.grade.gamma = { x: 0.15, y: 0.25, m: 0 }; }), cityV.id);
  await settled('grade');
  const graded = await programRgb();
  check('Grade changes the preview', lum(graded) > lum(ungraded) + 5, `before ${ungraded.map(v => v.toFixed(0))} after ${graded.map(v => v.toFixed(0))}`);
  await page.waitForTimeout(600);
  const scope = await L(() => { const c = document.querySelector('[data-testid="scope"]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n; });
  check('Scopes draw the picture', scope > 500, `${scope} lit pixels`);
  await shot('05-color');
  for (const k of ['waveform', 'vector', 'histogram']) {
    await page.click(`.scopes .seg button:text-is("${k === 'vector' ? 'Vector' : k[0].toUpperCase() + k.slice(1)}")`);
    await page.waitForTimeout(400);
  }
  await page.click('.scopes .seg button:text-is("Vector")');
  await page.waitForTimeout(400);
  await shot('06-color-vectorscope');

  /* --------------------------------------------------------------------- audio */
  await L(() => window.__psp.useUI.getState().setPage('audio'));
  await setFrame(0);
  await page.click('[data-testid="play"]');
  await page.waitForTimeout(2200);
  const playState = await L(() => ({ f: window.__psp.usePlayer.getState().frame, m: window.__psp.engine().meters() }));
  check('Playback advances in real time', playState.f > 40 && playState.f < 90, `frame ${playState.f} after ~2.2 s`);
  const a1 = (await P()).tracks.find(t => t.kind === 'audio').id;
  check('Audio meters move during playback', playState.m.master[0] > 0.01 && playState.m.tracks[a1]?.[0] > 0.01, `master ${playState.m.master[0].toFixed(3)}, A1 (sound from the video file) ${playState.m.tracks[a1]?.[0].toFixed(3)}`);
  await shot('07-audio-mixer');
  await page.click('[data-testid="play"]');
  await L(() => window.__psp.useProject.getState().edit('Mix', q => { const a1 = q.tracks.find(t => t.kind === 'audio'); a1.volume = -3; a1.pan = -0.3; }));

  /* ------------------------------------------------------------ save + reopen */
  const projFile = path.join(out, 'e2e-project.psproj');
  await L(f => window.__psp.api.saveProjectTo(window.__psp.useProject.getState().project, f).then(() => window.__psp.useProject.getState().markSaved(f)), projFile);
  const saved = await P();
  await L(f => window.__psp.openProject(f), projFile);
  await page.waitForTimeout(500);
  const reopened = await P();
  check('Project saves and reopens identically', JSON.stringify(reopened.clips) === JSON.stringify(saved.clips) && JSON.stringify(reopened.tracks) === JSON.stringify(saved.tracks), `${reopened.clips.length} clips`);

  /* ---------------------------------------------------------------- export */
  await L(() => window.__psp.useUI.getState().setPage('deliver'));
  await page.fill('[data-testid="export-name"]', 'e2e-render');
  await page.fill('[data-testid="export-dir"]', out);
  await shot('08-deliver');
  const tExp = Date.now();
  await page.click('[data-testid="render"]');
  await until(() => [...document.querySelectorAll('[data-testid="job"]')].some(j => j.classList.contains('done') || j.classList.contains('failed')), null, 300_000, 'export');
  const jobFailed = await L(() => document.querySelector('[data-testid="job"]').classList.contains('failed') ? document.querySelector('[data-testid="job"]').innerText : '');
  const outFile = path.join(out, 'e2e-render.mp4');
  check('Export finishes', !jobFailed && fs.existsSync(outFile), jobFailed || `${((Date.now() - tExp) / 1000).toFixed(1)} s`);
  await shot('09-deliver-done');
  if (fs.existsSync(outFile)) {
    const info = ffprobe(outFile);
    const v = info.streams.find(s => s.codec_type === 'video'), a = info.streams.find(s => s.codec_type === 'audio');
    check('Export is H.264 1080p30 with AAC audio', v?.codec_name === 'h264' && v.width === 1920 && v.height === 1080 && v.r_frame_rate === '30/1' && a?.codec_name === 'aac', `${v?.codec_name} ${v?.width}×${v?.height} ${v?.r_frame_rate} ${a?.codec_name}`);
    check('Export duration matches the timeline', Math.abs(Number(info.format.duration) - 16) < 0.15, `${Number(info.format.duration).toFixed(2)} s`);
    // What you see is what you render: compare preview and export at the same frames
    for (const f of [90, 135, 270, 400]) {
      await L(() => window.__psp.useUI.getState().setPage('deliver'));
      await setFrame(f);
      const pv = await programRgb();
      const ex = fileRgb(outFile, (f + 0.5) / 30);
      check(`Preview matches export at frame ${f}`, diff(pv, ex) < 12, `preview ${pv.map(v => v.toFixed(0))} export ${ex.map(v => v.toFixed(0))}`);
    }
  }

  /* --------------------------------------------------------- originals untouched */
  const changed = sources.filter(f => sha(f) !== hashes.get(f));
  check('Source media files are never modified', !changed.length, changed.join(', '));
  await L(() => window.__psp.useUI.getState().setPage('edit'));
  await setFrame(140);
  await L(() => window.__psp.useProject.getState().select([]));
  await page.waitForTimeout(400);
  await shot('10-edit-final');
} catch (e) {
  check('Unexpected error', false, e.stack || String(e));
  await shot('error').catch(() => {});
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await app.close().catch(() => {});
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
