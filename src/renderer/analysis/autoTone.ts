/**
 * Auto Tone & Auto White Balance. Both are measured on real renders of the
 * current image (small, offscreen render targets) and iterate toward targets,
 * so they respect the active profile, crop and lens corrections.
 */
import { host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { cloneEdit, type EditParams } from '@shared/edit';
import { neutralizeTempTint, type Vec3 } from '@shared/color';
import type { Renderer, RenderContext } from '../engine/pipeline';
import { computeGeometry } from '../engine/geometry';

const enc = (v: number) => Math.pow(Math.max(v, 0), 1 / 2.2);
const LUMA = [0.2627, 0.678, 0.0593];

export interface ToneStats { median: number; mean: number; sd: number; p001: number; p01: number; p99: number; p999: number; clipHi: number; clipLo: number }

export function toneStats(data: Float32Array): ToneStats {
  const vals: number[] = [];
  let clipHi = 0, clipLo = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 0.5) continue;
    const y = enc(LUMA[0] * data[i] + LUMA[1] * data[i + 1] + LUMA[2] * data[i + 2]);
    if (Math.max(data[i], data[i + 1], data[i + 2]) >= 0.995) clipHi++;
    if (y <= 0.02) clipLo++;
    vals.push(y);
  }
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))] ?? 0;
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length));
  return { median: q(0.5), mean, sd, p001: q(0.001), p01: q(0.01), p99: q(0.99), p999: q(0.999), clipHi: clipHi / Math.max(1, vals.length), clipLo: clipLo / Math.max(1, vals.length) };
}

function measure(r: Renderer, e: EditParams, rc: RenderContext): ToneStats {
  const src = r.source!;
  const g = computeGeometry(e, src.width, src.height, rc.lens);
  const out = r.render(e, { ...rc }, { scale: Math.min(1, 320 / Math.max(g.outW, g.outH)) }, 'auto');
  return toneStats(r.readSmall(out, 320).data);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Compute auto tone settings for an edit (pure; does not touch the store). */
export function computeAutoTone(r: Renderer, edit: EditParams, rc: RenderContext): EditParams {
  const e = cloneEdit(edit);
  Object.assign(e, { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
  // 1. Exposure: bring the median to a pleasant mid-tone
  for (let i = 0; i < 4; i++) {
    const s = measure(r, e, rc);
    const target = 0.44;
    const d = Math.log2(Math.pow(target, 2.2) / Math.max(Math.pow(s.median, 2.2), 1e-4)) * 0.8;
    if (Math.abs(d) < 0.03) break;
    e.exposure = clamp(e.exposure + d, -4, 4);
  }
  // 2. Highlights / shadows from clipping and tonal distribution
  let s = measure(r, e, rc);
  if (s.p99 > 0.9 || s.clipHi > 0.003) e.highlights = -Math.round(clamp(30 + s.clipHi * 4000 + (s.p99 - 0.9) * 300, 10, 85));
  if (s.p01 < 0.08 || s.clipLo > 0.01) e.shadows = Math.round(clamp(20 + s.clipLo * 600 + (0.08 - s.p01) * 300, 5, 70));
  // 3. Whites / blacks to set endpoints
  s = measure(r, e, rc);
  e.whites = Math.round(clamp(((0.97 / Math.max(s.p999, 0.2)) - 1) / 0.28 * 100 * 0.8, -60, 60));
  e.blacks = Math.round(clamp(((0.02 - s.p001) / 0.16) * 100 * 1.4, -50, 40));
  // 4. Contrast to reach a natural spread
  s = measure(r, e, rc);
  e.contrast = Math.round(clamp((0.21 - s.sd) * 260, -25, 35));
  e.vibrance = Math.max(e.vibrance, 8);
  return e;
}

/** Estimate neutral illuminant from scene-linear pixels (iterative gray-pixel weighting). */
export function estimateNeutral(data: Float32Array): Vec3 {
  let est: Vec3 = [1, 1, 1];
  for (let iter = 0; iter < 4; iter++) {
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (data[i + 3] < 0.5) continue;
      const m = Math.max(r, g, b), y = 0.26 * r + 0.68 * g + 0.06 * b;
      if (m > 0.95 || y < 0.01) continue;
      // chroma relative to current estimate
      const nr = r / est[0], ng = g / est[1], nb = b / est[2];
      const avg = (nr + ng + nb) / 3;
      const chroma = Math.hypot(nr - avg, ng - avg, nb - avg) / Math.max(avg, 1e-4);
      const w = Math.exp(-(chroma * chroma) / (iter === 0 ? 0.3 : 0.05)) * Math.sqrt(y);
      sr += r * w; sg += g * w; sb += b * w; sw += w;
    }
    if (sw <= 0) break;
    est = [sr / sw, sg / sw, sb / sw];
  }
  return est;
}

export function autoWhiteBalanceFor(r: Renderer, e: EditParams, rc: RenderContext, asShot: { temp: number; tint: number }) {
  const base = cloneEdit(e);
  const { data } = r.readSceneSmall(base, rc, 320);
  const n = estimateNeutral(data);
  return neutralizeTempTint(n, asShot.temp, asShot.tint);
}

/* ------------------------------------------------------------ store actions */

export function autoTone() {
  const h = host(), r = h.renderer;
  const dev = useDevelop.getState();
  if (!r?.source) return;
  const next = computeAutoTone(r, dev.edit, h.renderContext(dev.edit));
  h.requestRender();
  dev.replaceEdit(next, 'Auto Tone');
}

export function autoWhiteBalance() {
  const h = host(), r = h.renderer;
  const dev = useDevelop.getState();
  if (!r?.source) return;
  const wb = autoWhiteBalanceFor(r, dev.edit, h.renderContext(dev.edit), dev.asShot);
  dev.setEdit(e => { e.wb = { mode: 'auto', temp: wb.temp, tint: wb.tint }; }, 'Auto White Balance');
}

/** Eyedropper: make the clicked point (output uv) neutral. */
export function pickWhiteBalance(uv: [number, number]) {
  const h = host(), r = h.renderer;
  const dev = useDevelop.getState();
  if (!r?.source) return;
  const { w, h: hh, data } = r.readSceneSmall(dev.edit, h.renderContext(dev.edit), 512);
  const cx = Math.round(uv[0] * (w - 1)), cy = Math.round(uv[1] * (hh - 1));
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
    if (x < 0 || y < 0 || x >= w || y >= hh) continue;
    const i = (y * w + x) * 4;
    if (data[i + 3] < 0.5) continue;
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
  }
  if (!n) return;
  const wb = neutralizeTempTint([sr / n, sg / n, sb / n], dev.asShot.temp, dev.asShot.tint);
  dev.setEdit(e => { e.wb = { mode: 'custom', temp: wb.temp, tint: wb.tint }; }, 'White Balance (picker)');
  h.requestRender();
}
