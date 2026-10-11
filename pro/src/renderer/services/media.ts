/** Importing media and building its analysis assets (filmstrips, waveforms, proxies). */
import type { MediaItem } from '@shared/project';
import { api, fileUrl } from '../api';
import { useProject, P } from '../store/project';
import { useUI, toast } from '../store/ui';

const PLAYABLE_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const PLAYABLE_EXT = /\.(mp4|m4v|mov|webm|ogv)$/i;

/** Can Chromium decode this file directly? Tries a real <video> load for likely candidates. */
function playable(m: MediaItem): Promise<boolean> {
  if (m.kind !== 'video') return Promise.resolve(true);
  if (!m.videoCodec || !PLAYABLE_CODECS.has(m.videoCodec) || !PLAYABLE_EXT.test(m.path)) return Promise.resolve(false);
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const done = (ok: boolean) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); resolve(ok); };
    const timer = setTimeout(() => done(false), 10000);
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = fileUrl(m.path);
  });
}

const queue: MediaItem[] = [];
let running = false;

async function analyse(m: MediaItem) {
  const patch = (x: Partial<MediaItem>) => useProject.getState().patchMedia(m.id, x);
  const task = (label: string, progress: number | null) => useUI.getState().setTask({ id: `an:${m.id}`, label, progress });
  try {
    if (m.kind !== 'audio' && !m.thumbs) { task(`Filmstrip · ${m.name}`, null); patch({ thumbs: await api.thumbs(m) }); }
    if (m.hasAudio && !m.waveform) { task(`Waveform · ${m.name}`, null); patch({ waveform: await api.waveform(m) }); }
    if (m.kind === 'video' && !m.proxy && !(await playable(m))) {
      task(`Proxy · ${m.name}`, 0);
      const off = api.on('media:proxyProgress', (e: { id: string; progress: number }) => { if (e.id === m.id) task(`Proxy · ${m.name}`, e.progress); });
      try { patch({ proxy: await api.proxy(m) }); } finally { off(); }
    }
  } catch (e: any) {
    toast({ kind: 'error', title: `Couldn't analyse ${m.name}`, body: String(e?.message ?? e).slice(0, 240) }, 8000);
  } finally {
    useUI.getState().setTask({ id: `an:${m.id}`, done: true });
  }
}

export function enqueueAnalysis(items: MediaItem[]) {
  queue.push(...items);
  if (running) return;
  running = true;
  (async () => {
    while (queue.length) {
      const m = queue.shift()!;
      const cur = P().media.find(x => x.id === m.id);
      if (cur && !cur.missing) await analyse(cur);
    }
    running = false;
  })();
}

export async function importPaths(paths: string[]): Promise<MediaItem[]> {
  if (!paths.length) return [];
  const ui = useUI.getState();
  const off = api.on('media:progress', (e: { done: number; total: number; current?: string }) => {
    if (e.done < e.total) ui.setTask({ id: 'import', label: `Importing ${e.current ?? ''}`, progress: e.total ? e.done / e.total : null });
  });
  try {
    const { items, errors } = await api.importMedia(paths);
    const existing = new Set(P().media.map(m => m.path));
    const fresh = items.filter(m => !existing.has(m.path));
    if (fresh.length) useProject.getState().edit(`Import ${fresh.length} item${fresh.length > 1 ? 's' : ''}`, p => { p.media.push(...fresh); });
    if (errors.length) toast({ kind: 'error', title: `${errors.length} file${errors.length > 1 ? 's' : ''} couldn't be imported`, body: errors.slice(0, 3).map(e => `${e.path.split(/[\\/]/).pop()}: ${e.error}`).join('\n') }, 9000);
    else if (fresh.length) toast({ kind: 'success', title: `Imported ${fresh.length} item${fresh.length > 1 ? 's' : ''}` });
    else if (items.length) toast({ kind: 'info', title: 'Already in this project' });
    else toast({ kind: 'info', title: 'No supported media found' });
    enqueueAnalysis(fresh);
    return fresh;
  } finally {
    off();
    ui.setTask({ id: 'import', done: true });
  }
}

export async function importDialog(kind: 'files' | 'folder' = 'files') {
  return importPaths(await api.pickMedia(kind));
}

/** Point a missing media item at a new file (keeps every clip that uses it). */
export async function relink(m: MediaItem) {
  const info = await api.relink(m.name);
  if (!info) return;
  if (info.kind !== m.kind) { toast({ kind: 'error', title: 'Different kind of media', body: `${m.name} is ${m.kind}; the chosen file is ${info.kind}.` }); return; }
  useProject.getState().edit(`Relink ${m.name}`, p => {
    const x = p.media.find(y => y.id === m.id)!;
    Object.assign(x, info, { id: m.id, importedAt: m.importedAt, missing: false, thumbs: null, waveform: null, proxy: null });
  });
  enqueueAnalysis([P().media.find(x => x.id === m.id)!]);
  toast({ kind: 'success', title: `Relinked ${m.name}` });
}
