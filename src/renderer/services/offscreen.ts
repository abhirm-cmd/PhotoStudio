/**
 * Offscreen rendering: a second GPU context used for background thumbnail
 * updates (batch paste/sync, presets applied to many photos) and exports, so the
 * editor's viewer is never disturbed.
 */
import { Renderer, type RenderContext } from '../engine/pipeline';
import { loadSource, type Quality } from '../decode/sources';
import { computeGeometry } from '../engine/geometry';
import { lensCorrection, findProfile, matchProfile } from '../engine/lens';
import { encodeJpeg } from '../engine/host';
import { normalizeEdit, type EditParams } from '@shared/edit';
import type { Photo } from '@shared/types';
import { api, media } from '../api';
import type { MaskAsset } from '../engine/pipeline';

let renderer: Renderer | null = null;
let chain: Promise<unknown> = Promise.resolve();

function getRenderer() {
  renderer ??= new Renderer(new OffscreenCanvas(16, 16));
  return renderer;
}

/** Serialize all offscreen work (one GPU context). */
export function offscreen<T>(fn: (r: Renderer) => Promise<T>): Promise<T> {
  const run = chain.then(() => fn(getRenderer()));
  chain = run.catch(() => {});
  return run;
}

export async function loadMaskAssets(edit: EditParams, photoId: number): Promise<Map<string, MaskAsset>> {
  const assets = new Map<string, MaskAsset>();
  const refs = new Set<string>();
  for (const m of edit.masks) for (const c of m.components) if (c.type === 'ai') refs.add(c.ref);
  // Portrait layers exist only once the Portrait panel has been used on this photo
  const pt = edit.portrait;
  if (pt.skinSmoothing || pt.skinTone || pt.skinEvenness || pt.faceLight) refs.add(`ai:${photoId}:skin`);
  if (pt.eyeEnhance) refs.add(`ai:${photoId}:eyes`);
  if (pt.teethWhitening) refs.add(`ai:${photoId}:teeth`);
  await Promise.all([...refs].map(async ref => {
    try {
      const res = await fetch(media.blob(ref));
      if (!res.ok) return;
      const bmp = await createImageBitmap(await res.blob());
      assets.set(ref, { key: ref, width: bmp.width, height: bmp.height, data: bmp });
    } catch { /* missing asset: mask renders empty */ }
  }));
  return assets;
}

export function contextFor(photo: Photo, edit: EditParams, srcW: number, srcH: number, assets: Map<string, MaskAsset>): RenderContext {
  const g = computeGeometry(edit, srcW, srcH, null);
  const prof = edit.optics.profileId ? findProfile(edit.optics.profileId) : matchProfile(photo.exif.lens, photo.exif.make);
  return { lens: lensCorrection(edit.optics, prof, photo.exif.focalLength, photo.exif.aperture, g.frameW, g.frameH), assets };
}

export async function prepare(r: Renderer, photo: Photo, quality: Quality, edge = 2560) {
  const src = await loadSource(photo, quality, edge);
  if (r.source?.id !== src.id) r.setSource(src);
  return src;
}

/** Re-render a photo's thumbnail from its saved edit. */
export function refreshThumbnail(photo: Photo) {
  return offscreen(async r => {
    const edit = normalizeEdit(await api.getEdit(photo.id), photo.isRaw);
    const src = await prepare(r, photo, 'preview', 1600);
    if (edit.wb.mode === 'asShot') edit.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
    const rc = contextFor(photo, edit, src.width, src.height, await loadMaskAssets(edit, photo.id));
    const g = computeGeometry(edit, src.width, src.height, rc.lens);
    const out = r.render(edit, rc, { scale: Math.min(1, 1600 / Math.max(g.outW, g.outH)) });
    const jpeg = await encodeJpeg(r.readEncoded(out, 'srgb', 8) as Uint8Array, out.width, out.height);
    await api.storeRendered(photo.id, jpeg);
  });
}
