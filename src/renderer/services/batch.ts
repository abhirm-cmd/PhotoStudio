/** Operations applied to many photos at once (from the Library or Presets workspace). */
import { api } from '../api';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { applyPartial, normalizeEdit, blendEdits, type EditParams } from '@shared/edit';
import type { Photo, Preset } from '@shared/types';
import { offscreen, prepare, contextFor, loadMaskAssets, refreshThumbnail } from './offscreen';
import { computeEnhance } from '../analysis/enhance';

/** Apply a preset to an edit. Amount scales the preset's effect (0..1, >1 exaggerates numeric values). */
export function presetEdit(base: EditParams, preset: Preset, amount = 1): EditParams {
  return applyPartial(base, preset.settings as any, Math.max(0, amount));
}

export async function applyPresetToPhotos(ids: number[], preset: Preset, amount = 1) {
  const lib = useLibrary.getState();
  const dev = useDevelop.getState();
  const app = useApp.getState();
  const task = `preset-${Date.now()}`;
  let i = 0;
  for (const id of ids) {
    app.setTask({ id: task, label: `Applying ${preset.name}`, done: i, total: ids.length });
    if (id === dev.photoId) {
      dev.replaceEdit(presetEdit(dev.edit, preset, amount), `Preset: ${preset.name}`, { presetName: preset.name });
    } else {
      const p = lib.photos.find(x => x.id === id);
      const cur = normalizeEdit(await api.getEdit(id), p?.isRaw ?? true);
      await api.saveEdit(id, presetEdit(cur, preset, amount), { historyLabel: `Preset: ${preset.name}`, presetName: preset.name });
      if (p) refreshThumbnail(p).then(() => useLibrary.getState().bumpThumb(id)).catch(() => {});
    }
    i++;
  }
  app.endTask(task);
  lib.patchPhotos(ids, { hasEdits: true, presetName: preset.name });
  app.toast({ kind: 'success', title: `${preset.name} applied`, body: `${ids.length} photo${ids.length > 1 ? 's' : ''} updated. Undo is available in each photo's history.` });
}

/** AI Auto Enhance for photos that are not open in Develop, using the offscreen renderer. */
export async function autoEnhancePhotos(photos: Photo[], strength = 0.7) {
  const app = useApp.getState();
  const task = `enhance-${Date.now()}`;
  let done = 0, failed = 0;
  for (const p of photos) {
    app.setTask({ id: task, label: 'AI Auto Enhance', done, total: photos.length, detail: p.filename });
    try {
      await offscreen(async r => {
        const cur = normalizeEdit(await api.getEdit(p.id), p.isRaw);
        const src = await prepare(r, p, 'preview', 1600);
        if (cur.wb.mode === 'asShot') cur.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
        const rc = contextFor(p, cur, src.width, src.height, await loadMaskAssets(cur, p.id));
        const { edit } = computeEnhance(r, cur, rc, src.asShot, p.isRaw);
        const next = blendEdits(cur, edit, strength);
        next.wb.mode = 'auto';
        await api.saveEdit(p.id, next, { historyLabel: `AI Auto Enhance ${Math.round(strength * 100)}%`, aiEnhanced: true });
      });
      await refreshThumbnail(p);
      useLibrary.getState().bumpThumb(p.id);
    } catch (e) {
      console.warn('enhance failed', p.filename, e);
      failed++;
    }
    done++;
  }
  app.endTask(task);
  useLibrary.getState().patchPhotos(photos.map(p => p.id), { hasEdits: true, aiEnhanced: true });
  app.toast({ kind: failed ? 'error' : 'success', title: 'AI Auto Enhance complete', body: `${done - failed} enhanced${failed ? `, ${failed} could not be processed` : ''}.` });
}
