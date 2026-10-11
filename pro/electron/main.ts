import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, net, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { probe, makeThumbs, makeWaveform, makeProxy, grabFrame, FFMPEG, MEDIA_EXT } from './media';
import { buildExport, type ExportOptions } from '../src/shared/ffgraph';
import { analyzeReference, sampleColors } from './reference';
import { normalizeProject, type Project, type MediaItem } from '../src/shared/project';

const isDev = !!process.env.PHOTOSTUDIO_PRO_DEV_URL;
const isTest = !!process.env.PHOTOSTUDIO_PRO_TEST;
if (process.env.PHOTOSTUDIO_PRO_USER_DATA) app.setPath('userData', process.env.PHOTOSTUDIO_PRO_USER_DATA);
app.setName('PhotoStudio Pro');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win: BrowserWindow | null = null;
const cacheDir = () => { const d = path.join(app.getPath('userData'), 'cache'); fs.mkdirSync(d, { recursive: true }); return d; };
const send = (ch: string, ...a: any[]) => win?.webContents.send(ch, ...a);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

/** Serve a local file with HTTP range support so <video> can seek. */
function serveFile(file: string, req: Request): Response {
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404, headers: CORS });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  const headers: Record<string, string> = { ...CORS, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m?.[1] ? Number(m[1]) : 0;
    let end = m?.[2] ? Number(m[2]) : size - 1;
    if (!m?.[1] && m?.[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(stream as any, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(fs.createReadStream(file) as any, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function registerProtocols() {
  const distDir = path.join(__dirname, '..', 'dist');
  protocol.handle('app', async req => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.join(distDir, path.normalize(rel));
    if (!file.startsWith(distDir)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle('media', async req => {
    const url = new URL(req.url);
    if (url.hostname === 'file') return serveFile(decodeURIComponent(url.searchParams.get('p') ?? ''), req);
    if (url.hostname === 'cache') {
      const key = path.basename(decodeURIComponent(url.pathname));
      return serveFile(path.join(cacheDir(), key), req);
    }
    return new Response('Bad request', { status: 400, headers: CORS });
  });
}

/* ----------------------------------------------------------------- media */

function scanPaths(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { if (depth < 6) for (const f of fs.readdirSync(p)) if (!f.startsWith('.')) walk(path.join(p, f), depth + 1); }
    else if (MEDIA_EXT.includes(path.extname(p).slice(1).toLowerCase())) out.push(p);
  };
  for (const p of paths) walk(p, 0);
  return out;
}

async function importMedia(paths: string[]): Promise<{ items: MediaItem[]; errors: { path: string; error: string }[] }> {
  const items: MediaItem[] = [];
  const errors: { path: string; error: string }[] = [];
  const files = scanPaths(paths);
  let done = 0;
  for (const f of files) {
    send('media:progress', { done, total: files.length, current: path.basename(f) });
    try {
      const info = await probe(f);
      items.push({ ...info, id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, importedAt: new Date().toISOString(), thumbs: null, waveform: null });
    } catch (e: any) {
      errors.push({ path: f, error: firstLine(e?.stderr || e?.message) });
    }
    done++;
  }
  send('media:progress', { done, total: files.length });
  return { items, errors };
}

const firstLine = (s: string) => String(s ?? '').trim().split('\n').filter(Boolean).pop() ?? 'Unknown error';

/* ---------------------------------------------------------------- export */

const exportJobs = new Map<string, ChildProcess>();
const cancelled = new Set<string>();

async function runExport(jobId: string, project: Project, opts: ExportOptions, assets: { luts: Record<string, string>; titles: Record<string, Uint8Array> }) {
  // Never render over a source file
  const out = path.resolve(opts.output);
  if (project.media.some(m => path.resolve(m.path) === out)) return { ok: false, error: 'The output file is one of the project’s source media files. Choose another name.' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-export-'));
  const lutFiles: Record<string, string> = {}, titleFiles: Record<string, string> = {};
  for (const [id, cube] of Object.entries(assets.luts)) { const f = path.join(tmp, `${id}.cube`); fs.writeFileSync(f, cube); lutFiles[id] = f; }
  for (const [id, png] of Object.entries(assets.titles)) { const f = path.join(tmp, `${id}.png`); fs.writeFileSync(f, Buffer.from(png)); titleFiles[id] = f; }
  const cmd = buildExport(project, opts, { luts: lutFiles, titles: titleFiles });
  fs.writeFileSync(path.join(tmp, 'command.txt'), [FFMPEG, ...cmd.args].map(a => JSON.stringify(a)).join(' '));
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  return new Promise<{ ok: boolean; output?: string; error?: string; log?: string }>(resolve => {
    const proc = spawn(FFMPEG, cmd.args, { windowsHide: true });
    exportJobs.set(jobId, proc);
    let log = '', buf = '';
    const t0 = Date.now();
    proc.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m) {
          const sec = Number(m[1]) / 1e6;
          const frac = Math.min(1, sec / cmd.duration);
          const elapsed = (Date.now() - t0) / 1000;
          send('export:progress', { jobId, progress: frac, seconds: sec, eta: frac > 0.02 ? (elapsed / frac) * (1 - frac) : null, speed: elapsed > 0 ? sec / elapsed : 0 });
        }
      }
    });
    proc.stderr.on('data', d => { log += d; if (log.length > 200_000) log = log.slice(-100_000); });
    proc.on('close', code => {
      exportJobs.delete(jobId);
      fs.writeFileSync(path.join(tmp, 'ffmpeg.log'), log);
      if (code === 0) { fs.rmSync(tmp, { recursive: true, force: true }); resolve({ ok: true, output: opts.output }); }
      else {
        // An unfinished render is not a usable file; remove it (the source media is never touched)
        fs.rmSync(opts.output, { force: true });
        resolve({ ok: false, error: cancelled.has(jobId) ? 'Cancelled' : firstLine(log), log: path.join(tmp, 'ffmpeg.log') });
      }
      cancelled.delete(jobId);
    });
  });
}

/* ------------------------------------------------------------- projects */

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.psproj');
function readRecent(): string[] { try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((f: string) => fs.existsSync(f)); } catch { return []; } }
function pushRecent(f: string) { const r = [f, ...readRecent().filter(x => x !== f)].slice(0, 12); fs.writeFileSync(recentFile(), JSON.stringify(r)); }

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

function loadProject(file: string) {
  const p = normalizeProject(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const m of p.media) m.missing = !fs.existsSync(m.path);
  return p;
}

/* ---------------------------------------------------------------- IPC */

type Handler = (...args: any[]) => any;
const matchJobs = new Map<string, { cancelled: boolean }>();
const api: Record<string, Handler> = {
  'app:info': () => ({ version: app.getVersion(), platform: process.platform, isTest, ffmpeg: FFMPEG, userData: app.getPath('userData') }),
  'media:pick': async (kind: 'files' | 'folder') => {
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'folder' ? 'Import a folder of media' : 'Import media',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: kind === 'folder' ? undefined : [{ name: 'Media', extensions: MEDIA_EXT }],
    });
    return r.canceled ? [] : r.filePaths;
  },
  'media:import': (paths: string[]) => importMedia(paths),
  'media:thumbs': (m: MediaItem) => makeThumbs(m, cacheDir()),
  'media:waveform': (m: MediaItem) => makeWaveform(m, cacheDir()),
  'media:proxy': (m: MediaItem) => makeProxy(m, cacheDir(), f => send('media:proxyProgress', { id: m.id, progress: f })),
  'media:exists': (paths: string[]) => paths.map(p => fs.existsSync(p)),
  'media:relink': async (name: string) => {
    const r = await dialog.showOpenDialog(win!, { title: `Locate ${name}`, properties: ['openFile'], filters: [{ name: 'Media', extensions: MEDIA_EXT }] });
    if (r.canceled) return null;
    return { ...(await probe(r.filePaths[0])) };
  },
  'media:reveal': (p: string) => shell.showItemInFolder(p),
  'match:analyze': (jobId: string, file: string) => {
    const signal = { cancelled: false };
    matchJobs.set(jobId, signal);
    return analyzeReference(file, f => send('match:progress', { jobId, progress: f }), signal).finally(() => matchJobs.delete(jobId));
  },
  'match:cancel': (jobId: string) => { const s = matchJobs.get(jobId); if (s) s.cancelled = true; return true; },
  'match:colors': (file: string, times: number[], still: boolean) => sampleColors(file, times, still),
  'lut:pick': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import LUT', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
    if (r.canceled) return null;
    return { path: r.filePaths[0], name: path.basename(r.filePaths[0], '.cube'), text: fs.readFileSync(r.filePaths[0], 'utf8') };
  },
  'lut:read': (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
  'frame:still': async (file: string, t: number) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export still', defaultPath: 'still.jpg', filters: [{ name: 'JPEG', extensions: ['jpg'] }] });
    return r.canceled ? null : grabFrame(file, t, r.filePath!);
  },
  'still:save': async (png: Uint8Array, name: string) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export frame', defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(png));
    return r.filePath;
  },

  'project:open': async (file?: string) => {
    if (!file) {
      const r = await dialog.showOpenDialog(win!, { title: 'Open project', properties: ['openFile'], filters: [{ name: 'PhotoStudio Pro project', extensions: ['psproj'] }] });
      if (r.canceled) return null;
      file = r.filePaths[0];
    }
    const project = loadProject(file);
    pushRecent(file);
    return { file, project };
  },
  'project:save': async (project: Project, file: string | null, saveAs = false) => {
    if (!file || saveAs) {
      const r = await dialog.showSaveDialog(win!, { title: 'Save project', defaultPath: `${project.name || 'Untitled'}.psproj`, filters: [{ name: 'PhotoStudio Pro project', extensions: ['psproj'] }] });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    writeAtomic(file, JSON.stringify({ ...project, modifiedAt: new Date().toISOString() }, null, 1));
    pushRecent(file);
    return file;
  },
  'project:saveTo': (project: Project, file: string) => { writeAtomic(file, JSON.stringify(project, null, 1)); pushRecent(file); return file; },
  'project:autosave': (project: Project, file: string | null) => { writeAtomic(autosaveFile(), JSON.stringify({ project, file, savedAt: new Date().toISOString() })); return true; },
  'project:recover': () => { try { return JSON.parse(fs.readFileSync(autosaveFile(), 'utf8')); } catch { return null; } },
  'project:clearAutosave': () => { fs.rmSync(autosaveFile(), { force: true }); return true; },
  'project:recent': () => readRecent(),

  'export:pickOutput': async (name: string, ext: string) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export to', defaultPath: path.join(app.getPath('videos'), `${name}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return r.canceled ? null : r.filePath;
  },
  'export:defaultDir': () => app.getPath('videos'),
  'export:start': (jobId: string, project: Project, opts: ExportOptions, assets: any) => runExport(jobId, project, opts, assets),
  'export:cancel': (jobId: string) => { if (exportJobs.has(jobId)) { cancelled.add(jobId); exportJobs.get(jobId)!.kill('SIGKILL'); } return true; },
  'export:command': (project: Project, opts: ExportOptions) => buildExport(project, opts, { luts: {}, titles: {} }),
  'shell:reveal': (p: string) => shell.showItemInFolder(p),
  'shell:open': (p: string) => shell.openPath(p),
  'window:title': (t: string) => win?.setTitle(t),
  'app:close': () => { if (win) { (win as any).__allowClose = true; win.close(); } },
};

function registerIpc() {
  ipcMain.handle('api', async (_e: IpcMainInvokeEvent, method: string, ...args: any[]) => {
    const h = api[method];
    if (!h) throw new Error(`Unknown API method ${method}`);
    return h(...args);
  });
}

/* ---------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1680, height: 1020, minWidth: 1280, minHeight: 760,
    backgroundColor: '#0b0c0e',
    title: 'PhotoStudio Pro',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.once('ready-to-show', () => { if (!process.env.PHOTOSTUDIO_PRO_HIDDEN) win?.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Ask before closing with unsaved changes (the renderer answers)
  win.on('close', e => {
    if ((win as any).__allowClose) return;
    e.preventDefault();
    send('app:before-close');
  });
  if (isDev) win.loadURL(process.env.PHOTOSTUDIO_PRO_DEV_URL!);
  else win.loadURL('app://bundle/index.html');
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const act = (a: string) => () => send('menu:action', a);
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: act('project.new') },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: act('project.open') },
      { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: act('project.save') },
      { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: act('project.saveAs') },
      { type: 'separator' },
      { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: act('media.import') },
      { label: 'Export…', accelerator: 'CmdOrCtrl+M', click: act('page.deliver') },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: act('edit.undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: act('edit.redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    ] },
    { label: 'View', submenu: [{ role: 'reload', visible: isDev }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: act('app.shortcuts') }] },
  ]));
}

app.whenReady().then(() => {
  registerProtocols();
  registerIpc();
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => { for (const p of exportJobs.values()) p.kill('SIGKILL'); app.quit(); });
