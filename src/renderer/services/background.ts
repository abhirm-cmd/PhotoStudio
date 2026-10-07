/** Background services wired once at startup: RAW preview extraction for imports, catalog events, thumbnails. */
import { api, media } from '../api';
import { extractRawPreview } from '../decode/libraw';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { onEditCommitted, useDevelop } from '../store/develop';
import { host } from '../engine/host';
import { refreshThumbnail } from './offscreen';
import { analyzeAndTag } from '../analysis/tagging';
import type { ImportProgress } from '@shared/types';

/** Scene tags for photos that have none yet (on-device; runs after an import when enabled in Settings › AI). */
async function tagNewPhotos() {
  const all = await api.queryPhotos({});
  const todo = all.filter(p => !p.aiTags.length && p.thumbState === 'ready');
  if (todo.length) await analyzeAndTag(todo);
}

const FLIP_TO_ANGLE: Record<number, number> = { 0: 0, 3: 180, 5: 270, 6: 90 };

export function startBackgroundServices() {
  // Main process asks the renderer to pull embedded previews out of RAW files (LibRaw runs here).
  api.on('raw:thumb-request', async ({ reqId, id }: { reqId: string; id: number; path: string }) => {
    try {
      const bytes = new Uint8Array(await (await fetch(media.original(id))).arrayBuffer());
      const r = await extractRawPreview(bytes);
      const m = r.meta;
      const swap = m.flip === 5 || m.flip === 6;
      await api.rawThumbResult(reqId, {
        jpeg: r.jpeg, rgb: r.rgb, angle: r.jpeg ? FLIP_TO_ANGLE[m.flip] ?? 0 : 0,
        width: swap ? m.height : m.width, height: swap ? m.width : m.height,
        exif: { make: m.make, model: m.model, lens: m.lens, iso: m.iso, aperture: m.aperture, shutter: m.shutter, focalLength: m.focal, dateTaken: m.timestamp },
      });
    } catch (e: any) {
      await api.rawThumbResult(reqId, { error: `Unable to process this RAW file. ${e?.message ?? e}` });
    }
  });

  let refreshTimer: any = null;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { useLibrary.getState().refresh(); useLibrary.getState().refreshMeta(); }, 250);
  };
  api.on('photo:added', scheduleRefresh);
  api.on('catalog:changed', scheduleRefresh);
  api.on('photo:updated', async (id: number) => {
    const p = await api.getPhoto(id);
    if (p) { useLibrary.getState().replacePhoto(p); useLibrary.getState().bumpThumb(id); }
  });
  api.on('photo:thumb', (id: number) => useLibrary.getState().bumpThumb(id));

  api.on('import:progress', (p: ImportProgress) => {
    const app = useApp.getState();
    const label = p.phase === 'scanning' ? 'Scanning for photos…' : p.phase === 'importing' ? 'Importing photos' : p.phase === 'thumbnails' ? 'Building previews' : 'Import';
    if (p.phase === 'done') {
      app.endTask(p.jobId);
      const parts = [`${p.imported} imported`];
      if (p.duplicates) parts.push(`${p.duplicates} duplicate${p.duplicates > 1 ? 's' : ''} skipped`);
      if (p.failed) parts.push(`${p.failed} failed`);
      app.toast({ kind: p.failed ? 'error' : 'success', title: 'Import complete', body: parts.join(' · ') + (p.message && p.failed ? ` — ${p.message}` : '') });
      scheduleRefresh();
      const ai = app.settings?.ai;
      if (p.imported && ai && ai.provider !== 'off' && ai.analyzeOnImport) setTimeout(tagNewPhotos, 2500);
    } else {
      app.setTask({ id: p.jobId, label, done: p.done, total: p.total, detail: p.current, cancel: () => api.cancelImport(p.jobId) });
    }
  });

  api.on('backup:done', () => useApp.getState().toast({ kind: 'success', title: 'Catalog backed up', body: 'Automatic backup completed.' }));

  // After edits are committed, refresh the catalog thumbnail from the real render.
  onEditCommitted(async id => {
    const dev = useDevelop.getState();
    try {
      if (dev.photoId === id && host().photo?.id === id) {
        const jpeg = await host().storeThumbnail(id, dev.edit);
        if (jpeg) await api.storeRendered(id, jpeg);
      } else {
        const p = useLibrary.getState().photos.find(x => x.id === id) ?? (await api.getPhoto(id));
        if (p && p.thumbState !== 'error') await refreshThumbnail(p);
      }
    } catch (e) { console.warn('thumbnail update failed', e); }
  });
}
