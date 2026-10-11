import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, net, clipboard, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Catalog } from './catalog';
import { PreviewCache, decodeToRgb16 } from './media';
import { Importer, scanPaths, type RawThumbResult } from './importer';
import { SettingsStore } from './settings';
import { exportOne } from './exporter';
import { createBackup, listBackups, restoreBackup, isBackupDue } from './backup';
import { readMetadata } from './metadata';
import { seedBuiltinPresets } from './seed';
import type { ExportSettings, ImportOptions, Photo, Preset } from '../src/shared/types';
import type { EditParams } from '../src/shared/edit';
import { iccFor } from './icc';

const isDev = !!process.env.PHOTOSTUDIO_DEV_URL;
const isTest = !!process.env.PHOTOSTUDIO_TEST;
if (process.env.PHOTOSTUDIO_USER_DATA) app.setPath('userData', process.env.PHOTOSTUDIO_USER_DATA);
app.setName('PhotoStudio');

protocol.registerSchemesAsPrivileged([
  { scheme: 'photostudio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Shape detection (FaceDetector) powers the on-device eye/teeth/skin masks.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

const lensFile = () => path.join(app.getPath('userData'), 'lens-profiles.json');

let win: BrowserWindow | null = null;
let catalog: Catalog;
let previews: PreviewCache;
let settings: SettingsStore;
let importer: Importer;

const ISOLATION_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const MEDIA_HEADERS = { 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Width, X-Height, X-Bits' };

function openCatalog() {
  const dir = settings.data.catalog.location;
  catalog = new Catalog(path.join(dir, 'PhotoStudio Catalog.lcat'));
  previews = new PreviewCache(path.join(dir, 'Previews'));
  if (!catalog.hasBuiltinPresets()) seedBuiltinPresets(catalog);
  importer = new Importer(catalog, previews, () => (win && !win.isDestroyed() ? requestRawThumb : null));
  importer.on('progress', p => send('import:progress', p));
  importer.on('photo-added', id => send('photo:added', id));
  importer.on('photo-updated', id => send('photo:updated', id));
}

function send(channel: string, ...args: any[]) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); }

/* ---------------------------------------------------- RAW preview bridge */

const pendingThumbs = new Map<string, (r: RawThumbResult) => void>();
let thumbSeq = 0;
function requestRawThumb(id: number, file: string): Promise<RawThumbResult> {
  return new Promise(resolve => {
    const reqId = `t${++thumbSeq}`;
    const timer = setTimeout(() => { pendingThumbs.delete(reqId); resolve({ error: 'Timed out while decoding the RAW preview.' }); }, 120_000);
    pendingThumbs.set(reqId, r => { clearTimeout(timer); resolve(r); });
    send('raw:thumb-request', { reqId, id, path: file });
  });
}

/* -------------------------------------------------------------- protocols */

function registerProtocols() {
  const distDir = path.join(__dirname, '..', 'dist');
  protocol.handle('photostudio', async req => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.join(distDir, path.normalize(rel));
    if (!file.startsWith(distDir)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    return new Response(res.body, { status: res.status, headers });
  });

  protocol.handle('media', async req => {
    const url = new URL(req.url);
    const kind = url.hostname;
    const id = Number(url.pathname.slice(1));
    try {
      if (kind === 'thumb' || kind === 'preview') {
        const p = kind === 'thumb' ? previews.thumbPath(id) : previews.previewPath(id);
        if (!fs.existsSync(p)) return new Response('Not found', { status: 404, headers: MEDIA_HEADERS });
        return new Response(fs.readFileSync(p), { headers: { ...MEDIA_HEADERS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } });
      }
      if (kind === 'original') {
        const photo = catalog.getPhoto(id);
        if (!photo) return new Response('Not found', { status: 404, headers: MEDIA_HEADERS });
        const data = await fs.promises.readFile(photo.path);
        return new Response(data, { headers: { ...MEDIA_HEADERS, 'Content-Type': 'application/octet-stream' } });
      }
      if (kind === 'reference') {
        const file = url.searchParams.get('path')!;
        const data = await fs.promises.readFile(file);
        return new Response(data, { headers: { ...MEDIA_HEADERS, 'Content-Type': 'application/octet-stream' } });
      }
      if (kind === 'decoded') {
        const photo = catalog.getPhoto(id);
        if (!photo) return new Response('Not found', { status: 404, headers: MEDIA_HEADERS });
        const max = Number(url.searchParams.get('max')) || undefined;
        const r = await decodeToRgb16(photo.path, max);
        return new Response(r.data as unknown as BodyInit, { headers: { ...MEDIA_HEADERS, 'Content-Type': 'application/octet-stream', 'X-Width': String(r.width), 'X-Height': String(r.height), 'X-Bits': '16' } });
      }
      if (kind === 'blob') {
        const b = catalog.getBlob(decodeURIComponent(url.pathname.slice(1)));
        if (!b) return new Response('Not found', { status: 404, headers: MEDIA_HEADERS });
        return new Response(b.data as unknown as BodyInit, { headers: { ...MEDIA_HEADERS, 'Content-Type': b.mime } });
      }
      if (kind === 'asset') {
        const file = path.join(resourcesDir(), decodeURIComponent(url.pathname));
        if (!file.startsWith(resourcesDir())) return new Response('Forbidden', { status: 403 });
        return new Response(fs.readFileSync(file), { headers: { ...MEDIA_HEADERS } });
      }
    } catch (e: any) {
      return new Response(String(e?.message ?? e), { status: 500, headers: MEDIA_HEADERS });
    }
    return new Response('Bad request', { status: 400, headers: MEDIA_HEADERS });
  });
}

const resourcesDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(__dirname, '..', 'resources'));

/* ---------------------------------------------------------------- IPC API */

type Handler = (...args: any[]) => any;
const api: Record<string, Handler> = {
  'app:info': () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData'), catalogFile: catalog.file, isDev, isTest }),
  'settings:get': () => settings.data,
  'settings:update': (patch: any) => {
    const prevLoc = settings.data.catalog.location;
    const s = settings.update(patch);
    if (patch?.catalog?.location && patch.catalog.location !== prevLoc) { catalog.close(); openCatalog(); send('catalog:changed'); }
    return s;
  },

  'photos:query': (q: any) => catalog.queryPhotos(q ?? {}),
  'photos:get': (id: number) => catalog.getPhoto(id),
  'photos:getMany': (ids: number[]) => catalog.getPhotos(ids),
  'photos:setRating': (ids: number[], r: number) => catalog.setRating(ids, r),
  'photos:setFlag': (ids: number[], f: string) => catalog.setFlag(ids, f),
  'photos:setLabel': (ids: number[], l: string) => catalog.setLabel(ids, l),
  'photos:setFavorite': (ids: number[], v: boolean) => catalog.setFavorite(ids, v),
  'photos:addKeywords': (ids: number[], w: string[]) => catalog.addKeywords(ids, w),
  'photos:removeKeyword': (ids: number[], w: string) => catalog.removeKeyword(ids, w),
  'photos:setIptc': (ids: number[], m: any) => catalog.setIptc(ids, m),
  'photos:setAiTags': (id: number, tags: string[]) => catalog.setAiTags(id, tags),
  'photos:remove': (ids: number[]) => { catalog.removePhotos(ids); ids.forEach(i => previews.remove(i)); },
  'photos:retryPreview': async (id: number) => { const p = catalog.getPhoto(id); if (p) { catalog.setThumbState(id, 'pending'); send('photo:updated', id); await importer.buildOne(id, p.path, p.isRaw); } return catalog.getPhoto(id); },
  'photos:reveal': (id: number) => { const p = catalog.getPhoto(id); if (p) shell.showItemInFolder(p.path); },
  'photos:virtualCopy': (id: number, name?: string) => { const nid = catalog.createVirtualCopy(id, name); previews.copy(id, nid); return nid; },
  'photos:readMetadata': async (id: number) => { const p = catalog.getPhoto(id); return p ? readMetadata(p.path) : null; },
  'photos:distinct': () => catalog.distinctValues(),
  'photos:stats': () => catalog.stats(),
  'photos:folders': () => catalog.folderTree(),
  'photos:storeRendered': async (id: number, jpeg: Uint8Array) => { await previews.storeRendered(id, Buffer.from(jpeg)); send('photo:thumb', id); },
  'photos:reportIssue': async (id: number) => {
    const p = catalog.getPhoto(id);
    const report = [`PhotoStudio ${app.getVersion()} (${process.platform} ${process.arch})`, `File: ${p?.path}`, `Format: ${p?.ext}`, `Size: ${p?.fileSize} bytes`, `Camera: ${p?.exif.make ?? ''} ${p?.exif.model ?? ''}`, `Error: ${p?.error}`, `Date: ${new Date().toISOString()}`].join('\n');
    const dir = path.join(app.getPath('userData'), 'Reports');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `issue-${id}-${Date.now()}.txt`);
    fs.writeFileSync(f, report);
    clipboard.writeText(report);
    shell.showItemInFolder(f);
    return f;
  },

  'edit:get': (id: number) => catalog.getEdit(id),
  'edit:save': (id: number, edit: EditParams, opts: any) => catalog.saveEdit(id, edit, opts ?? {}),
  'history:get': (id: number) => catalog.getHistory(id),
  'history:truncate': (id: number, after: number) => catalog.truncateHistory(id, after),
  'history:clear': (id: number) => catalog.clearHistory(id),
  'snapshots:get': (id: number) => catalog.getSnapshots(id),
  'snapshots:add': (id: number, name: string, e: EditParams) => catalog.addSnapshot(id, name, e),
  'snapshots:delete': (sid: number) => catalog.deleteSnapshot(sid),

  'collections:list': () => catalog.getCollections(),
  'collections:create': (name: string, kind: any, rules?: any, parent?: number | null) => catalog.createCollection(name, kind, rules ?? null, parent ?? null),
  'collections:update': (id: number, patch: any) => catalog.updateCollection(id, patch),
  'collections:delete': (id: number) => catalog.deleteCollection(id),
  'collections:add': (cid: number, ids: number[]) => catalog.addToCollection(cid, ids),
  'collections:removePhotos': (cid: number, ids: number[]) => catalog.removeFromCollection(cid, ids),

  'presets:list': () => catalog.getPresets(),
  'presets:save': (p: Preset) => catalog.savePreset(p),
  'presets:delete': (id: string) => catalog.deletePreset(id),
  'presets:export': async (presets: Preset[]) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export presets', defaultPath: presets.length === 1 ? `${presets[0].name}.photostudio-preset.json` : 'PhotoStudio Presets.photostudio-preset.json', filters: [{ name: 'PhotoStudio preset', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({ format: 'photostudio-preset', version: 1, presets }, null, 2));
    return r.filePath;
  },
  'presets:import': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Import presets', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PhotoStudio preset', extensions: ['json'] }] });
    if (r.canceled) return [];
    const out: any[] = [];
    for (const f of r.filePaths) {
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); out.push(...(Array.isArray(j.presets) ? j.presets : [j])); } catch { /* skip invalid */ }
    }
    return out;
  },
  'exportPresets:list': () => catalog.getExportPresets(),
  'exportPresets:save': (p: any) => catalog.saveExportPreset(p),
  'exportPresets:delete': (id: string) => catalog.deleteExportPreset(id),

  'blobs:put': (key: string, mime: string, data: Uint8Array) => catalog.putBlob(key, mime, data),

  'import:pick': async (kind: 'files' | 'folder') => {
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'files' ? 'Import photos' : 'Import folder',
      properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  },
  'import:scan': async (paths: string[], recursive: boolean) => (await scanPaths(paths, recursive)).length,
  'import:start': (opts: ImportOptions) => { const jobId = `imp-${Date.now()}`; importer.run(jobId, opts).then(() => send('catalog:changed')); return jobId; },
  'import:cancel': (jobId: string) => importer.cancel(jobId),
  'import:demo': async () => {
    const dir = path.join(resourcesDir(), 'demo');
    if (!fs.existsSync(dir)) return null;
    const jobId = `demo-${Date.now()}`;
    importer.run(jobId, { paths: [dir], recursive: true, mode: 'reference', skipDuplicates: true, keywords: ['demo'] }).then(() => { settings.update({ onboarding: { demoLoaded: true } } as any); send('catalog:changed'); });
    return jobId;
  },
  'raw:thumb-result': (reqId: string, result: RawThumbResult) => { pendingThumbs.get(reqId)?.(result); pendingThumbs.delete(reqId); },

  'dialog:pickFolder': async (title?: string) => { const r = await dialog.showOpenDialog(win!, { title: title ?? 'Choose folder', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  'dialog:pickImage': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose reference image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'dng'] }] });
    return r.canceled ? null : r.filePaths[0];
  },
  'dialog:openTextFiles': async (title: string, exts: string[]) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Files', extensions: exts }] });
    if (r.canceled) return [];
    return r.filePaths.map(f => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
  },
  'lens:list': () => { try { return JSON.parse(fs.readFileSync(lensFile(), 'utf8')); } catch { return []; } },
  'lens:save': (profiles: unknown[]) => { fs.writeFileSync(lensFile(), JSON.stringify(profiles, null, 1)); return true; },
  'shell:reveal': (p: string) => shell.showItemInFolder(p),
  'shell:open': (p: string) => shell.openPath(p),

  'export:defaultDir': () => path.join(app.getPath('pictures'), 'PhotoStudio Exports'),
  'export:write': async (photoId: number, pixels: Uint8Array | Uint16Array, width: number, height: number, s: ExportSettings, seq: number) => {
    const photo = catalog.getPhoto(photoId);
    if (!photo) throw new Error('Photo not found');
    return exportOne({ photo, pixels, width, height, seq }, s);
  },
  'export:icc': (id: string) => iccFor(id),

  'backup:list': () => listBackups(settings.data.catalog.backupLocation),
  'backup:create': () => { const b = createBackup(catalog, settings.data.catalog.backupLocation, settings.data.catalog.keepBackups); settings.update({ catalog: { lastBackup: b.createdAt } } as any); return b; },
  'backup:restore': (file: string) => { restoreBackup(catalog, file, settings.data.catalog.backupLocation); app.relaunch(); app.exit(0); },

  'cache:size': () => previews.sizeBytes(),
  'cache:clear': () => previews.clear(),
  'window:toggleFullscreen': () => win?.setFullScreen(!win.isFullScreen()),
};

function registerIpc() {
  ipcMain.handle('api', async (_e: IpcMainInvokeEvent, method: string, ...args: any[]) => {
    const h = api[method];
    if (!h) throw new Error(`Unknown API method ${method}`);
    return h(...args);
  });
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1280, minHeight: 720,
    backgroundColor: '#0e0f11',
    title: 'PhotoStudio · Alternative for Lightroom',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#121316', symbolColor: '#c9ccd3', height: 40 },
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => { if (!process.env.PHOTOSTUDIO_HIDDEN) win?.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (isDev) win.loadURL(process.env.PHOTOSTUDIO_DEV_URL!);
  else win.loadURL('photostudio://app/index.html');
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const act = (a: string) => () => send('menu:action', a);
  const mac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'Import Photos…', accelerator: 'CmdOrCtrl+Shift+I', click: act('library.import') },
      { label: 'Export…', accelerator: 'CmdOrCtrl+Shift+E', click: act('workspace.export') },
      { type: 'separator' },
      { label: 'Back Up Catalog Now', click: act('backup.now') },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: act('app.settings') },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload', visible: isDev }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: act('app.shortcuts') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  settings = new SettingsStore(app.getPath('userData'), app.getPath('pictures'));
  openCatalog();
  registerProtocols();
  registerIpc();
  buildMenu();
  createWindow();
  const cat = settings.data.catalog;
  if (cat.autoBackup !== 'on-exit' && isBackupDue(cat.lastBackup, cat.autoBackup) && catalog.stats().photos > 0) {
    setTimeout(() => { try { const b = createBackup(catalog, cat.backupLocation, cat.keepBackups); settings.update({ catalog: { lastBackup: b.createdAt } } as any); send('backup:done', b); } catch (e) { console.error('auto-backup failed', e); } }, 15_000);
  }
});

app.on('before-quit', () => {
  try {
    if (settings?.data.catalog.autoBackup === 'on-exit' && catalog.stats().photos > 0) createBackup(catalog, settings.data.catalog.backupLocation, settings.data.catalog.keepBackups);
  } catch (e) { console.error(e); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });

export type { Photo };
