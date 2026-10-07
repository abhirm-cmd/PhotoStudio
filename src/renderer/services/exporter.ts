/**
 * Batch export. Each photo is decoded at full quality, rendered through the
 * same GPU pipeline as the editor (on the offscreen renderer) in overlapping
 * tiles so any resolution fits in GPU memory, encoded to the requested colour
 * space / bit depth, and handed to the main process for file writing (sharp:
 * resize, output sharpening, metadata, ICC, watermark).
 */
import { api } from '../api';
import { offscreen, prepare, contextFor, loadMaskAssets } from './offscreen';
import { computeGeometry } from '../engine/geometry';
import { normalizeEdit } from '@shared/edit';
import { targetSize } from '@shared/exportSize';
import type { ExportProgress, ExportSettings, Photo } from '@shared/types';
import type { Renderer, RenderContext } from '../engine/pipeline';
import type { EditParams } from '@shared/edit';

const TILE = 2048;
const MARGIN = 48;

export interface ExportJob { id: string; cancel(): void; done: Promise<ExportProgress> }

/** Render an edit at `scale` into one RGB buffer, tile by tile. */
export function renderTiled(r: Renderer, e: EditParams, rc: RenderContext, scale: number, space: string, bits: 8 | 16, linear: boolean) {
  const src = r.source!;
  const g = computeGeometry(e, src.width, src.height, rc.lens);
  const W = Math.max(1, Math.round(g.outW * scale)), H = Math.max(1, Math.round(g.outH * scale));
  const out = bits === 16 ? new Uint16Array(W * H * 3) : new Uint8Array(W * H * 3);
  for (let ty = 0; ty < H; ty += TILE) {
    for (let tx = 0; tx < W; tx += TILE) {
      const tw = Math.min(TILE, W - tx), th = Math.min(TILE, H - ty);
      const single = tw === W && th === H;
      const res = r.render(e, rc, single ? { scale } : { scale, region: [tx / W, ty / H, tw / W, th / H], margin: MARGIN }, 'export');
      const m = res.margin;
      // Region rounding can differ by a pixel; read what we need from the tile interior.
      const rw = Math.min(tw, res.width - 2 * m), rh = Math.min(th, res.height - 2 * m);
      const px = r.readEncoded(res, space, bits, linear, { x: m, y: m, w: rw, h: rh });
      for (let y = 0; y < rh; y++) {
        const dst = ((ty + y) * W + tx) * 3;
        out.set(px.subarray(y * rw * 3, (y + 1) * rw * 3) as any, dst);
      }
    }
  }
  return { pixels: out, width: W, height: H };
}

export function startExport(photos: Photo[], settings: ExportSettings, onProgress: (p: ExportProgress) => void): ExportJob {
  const id = `exp-${Date.now()}`;
  let cancelled = false;
  const prog: ExportProgress = { jobId: id, total: photos.length, done: 0, failed: 0, phase: 'rendering', outputs: [] };
  const emit = () => onProgress({ ...prog, outputs: [...(prog.outputs ?? [])] });
  const done = (async () => {
    emit();
    let seq = 0;
    for (const photo of photos) {
      if (cancelled) { prog.phase = 'cancelled'; break; }
      seq++;
      prog.current = photo.copyName ? `${photo.filename} (${photo.copyName})` : photo.filename;
      prog.phase = 'rendering';
      emit();
      try {
        const { pixels, width, height } = await offscreen(async r => {
          const edit = normalizeEdit(await api.getEdit(photo.id), photo.isRaw);
          const src = await prepare(r, photo, 'full');
          if (edit.wb.mode === 'asShot') edit.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
          const rc = contextFor(photo, edit, src.width, src.height, await loadMaskAssets(edit, photo.id));
          const g = computeGeometry(edit, src.width, src.height, rc.lens);
          // Full-resolution output size in camera pixels
          const k = src.fullWidth / src.width;
          const fullW = g.outW * k, fullH = g.outH * k;
          const t = settings.format === 'dng' ? null : targetSize(settings.resize, Math.round(fullW), Math.round(fullH));
          // Render at the target size (main process does the exact final resample) — never above source resolution.
          const scale = t ? Math.min(1, Math.max(t.width / g.outW, t.height / g.outH)) : 1;
          const dng = settings.format === 'dng';
          const space = dng ? 'rec2020' : settings.colorSpace;
          const bits: 8 | 16 = dng || (settings.format !== 'jpeg' && settings.bitDepth === 16) ? 16 : 8;
          return renderTiled(r, edit, rc, scale, space, bits, dng);
        });
        prog.phase = 'encoding';
        emit();
        const file = await api.exportWrite(photo.id, pixels, width, height, settings, seq);
        if (file) prog.outputs!.push(file);
      } catch (e: any) {
        console.error('export failed', e);
        prog.failed++;
        prog.message = `${photo.filename}: ${e?.message ?? e}`;
      }
      prog.done++;
      emit();
    }
    if (!cancelled) prog.phase = 'done';
    prog.current = undefined;
    emit();
    return prog;
  })();
  return { id, cancel: () => { cancelled = true; }, done };
}

export function defaultExportSettings(destination: string): ExportSettings {
  return {
    format: 'jpeg', quality: 90, bitDepth: 8,
    resize: { mode: 'none', width: 3000, height: 2000, long: 2048, megapixels: 12, noEnlarge: true },
    ppi: 300, colorSpace: 'srgb', metadata: 'all', removeLocation: false,
    sharpen: { enabled: false, target: 'screen', amount: 'standard' },
    filenameTemplate: '{filename}', destination, subfolder: '', conflict: 'unique',
    watermark: { enabled: false, text: '© ', opacity: 60, size: 3, position: 'br' },
  };
}
