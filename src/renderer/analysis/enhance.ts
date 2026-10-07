/**
 * AI Auto Enhance.
 *
 * Runs entirely on-device. It measures the current render (tone distribution,
 * colour cast, saturation, haze, skin and sky coverage) and builds a complete
 * edit from those measurements: auto tone + auto white balance as the base,
 * then scene-aware refinements (dehaze for flat/hazy scenes, gentler vibrance
 * for skin, sky protection, local contrast for flat midtones). The result is a
 * normal, fully editable set of slider values blended by `strength`.
 */
import { host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { blendEdits, cloneEdit, type EditParams } from '@shared/edit';
import { linearSrgbToOklab, convertMatrix, SPACES } from '@shared/color';
import { computeAutoTone, autoWhiteBalanceFor } from './autoTone';
import type { Renderer, RenderContext } from '../engine/pipeline';
import { computeGeometry } from '../engine/geometry';

export interface SceneAnalysis {
  /** Median perceptual lightness 0..1 */
  key: number;
  /** Mean OkLab chroma */
  chroma: number;
  /** Mean dark-channel value (higher = hazier / flatter) */
  haze: number;
  /** Fraction of pixels that look like skin */
  skin: number;
  /** Fraction of pixels that look like sky (bright blue/cyan in the upper half) */
  sky: number;
  /** Fraction of near-green foliage */
  foliage: number;
  /** Warm (positive) or cool (negative) mean hue bias in OkLab b */
  warmth: number;
  /** Local contrast estimate (mean absolute neighbour difference) */
  detail: number;
}

const toSrgb = convertMatrix(SPACES.rec2020, SPACES.srgb);

/** Analyse linear Rec.2020 RGBA float pixels. */
export function analyzePixels(data: Float32Array, w: number, h: number): SceneAnalysis {
  const L: number[] = [];
  let chroma = 0, haze = 0, skin = 0, sky = 0, foliage = 0, warm = 0, n = 0, det = 0, dn = 0;
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 0.5) { lum[y * w + x] = -1; continue; }
    const r = Math.max(0, toSrgb[0] * data[i] + toSrgb[1] * data[i + 1] + toSrgb[2] * data[i + 2]);
    const g = Math.max(0, toSrgb[3] * data[i] + toSrgb[4] * data[i + 1] + toSrgb[5] * data[i + 2]);
    const b = Math.max(0, toSrgb[6] * data[i] + toSrgb[7] * data[i + 1] + toSrgb[8] * data[i + 2]);
    const [l, a, bb] = linearSrgbToOklab([r, g, b]);
    const c = Math.hypot(a, bb);
    const hue = (Math.atan2(bb, a) * 180) / Math.PI;
    L.push(l);
    lum[y * w + x] = l;
    chroma += c;
    haze += Math.min(r, g, b);
    warm += bb;
    // Skin: warm hues, moderate chroma, mid lightness (works across skin tones)
    if (hue > 20 && hue < 95 && c > 0.025 && c < 0.16 && l > 0.3 && l < 0.92) skin++;
    // Sky: blue/cyan, reasonably bright, top 55% of frame
    if (y < h * 0.55 && hue > 200 && hue < 280 && l > 0.55 && c > 0.02) sky++;
    if (hue > 110 && hue < 165 && c > 0.04) foliage++;
    n++;
  }
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
    const a = lum[y * w + x], b = lum[y * w + x - 1];
    if (a < 0 || b < 0) continue;
    det += Math.abs(a - b); dn++;
  }
  L.sort((p, q) => p - q);
  const N = Math.max(1, n);
  return {
    key: L[Math.floor(L.length / 2)] ?? 0.5,
    chroma: chroma / N, haze: haze / N, skin: skin / N, sky: sky / N, foliage: foliage / N,
    warmth: warm / N, detail: det / Math.max(1, dn),
  };
}

export function analyzeRender(r: Renderer, e: EditParams, rc: RenderContext): SceneAnalysis {
  const src = r.source!;
  const g = computeGeometry(e, src.width, src.height, rc.lens);
  const out = r.render(e, rc, { scale: Math.min(1, 320 / Math.max(g.outW, g.outH)) }, 'auto');
  const s = r.readSmall(out, 320);
  return analyzePixels(s.data, s.w, s.h);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Build the full enhanced edit (strength 1). Pure aside from offscreen renders. */
export function computeEnhance(r: Renderer, edit: EditParams, rc: RenderContext, asShot: { temp: number; tint: number }, isRaw: boolean): { edit: EditParams; analysis: SceneAnalysis; notes: string[] } {
  const notes: string[] = [];
  let e = cloneEdit(edit);
  // 1. Neutralize colour cast first so tone measurements see correct colour
  const wb = autoWhiteBalanceFor(r, e, rc, asShot);
  const before = analyzeRender(r, e, rc);
  // Keep a little of the original warmth for warm scenes (sunsets, golden hour) instead of fully neutralizing
  const warmScene = before.warmth > 0.025 && before.sky < 0.2;
  const keep = warmScene ? 0.45 : 0.15;
  e.wb = { mode: 'auto', temp: Math.round(wb.temp + (e.wb.temp - wb.temp) * keep), tint: Math.round(wb.tint + (e.wb.tint - wb.tint) * keep) };
  if (warmScene) notes.push('kept warm light');
  // 2. Tone
  e = computeAutoTone(r, e, rc);
  // 3. Scene analysis on the toned image
  const a = analyzeRender(r, e, rc);
  // Haze / flatness
  if (a.haze > 0.08) { e.effects.dehaze = Math.round(clamp((a.haze - 0.08) * 220, 4, 30)); notes.push('reduced haze'); }
  // Local contrast for flat images; gentle when skin dominates
  const flat = clamp((0.045 - a.detail) * 900, -10, 25);
  e.effects.clarity = Math.round(a.skin > 0.18 ? Math.min(flat, 6) : flat + 6);
  e.effects.texture = Math.round(a.skin > 0.18 ? -4 : clamp(flat * 0.6 + 6, 0, 18));
  // Colour: vibrance toward a target chroma, protecting skin
  const targetChroma = a.skin > 0.18 ? 0.055 : 0.075;
  e.vibrance = Math.round(clamp((targetChroma - a.chroma) * 900, -10, a.skin > 0.18 ? 18 : 35));
  e.saturation = Math.round(clamp((targetChroma - a.chroma) * 150, -8, 6));
  if (a.skin > 0.18) { e.hsl.orange.saturation = Math.min(e.hsl.orange.saturation, -4); e.hsl.orange.luminance = Math.max(e.hsl.orange.luminance, 4); notes.push('portrait-friendly colour'); }
  // Sky: hold highlights, deepen blue slightly
  if (a.sky > 0.12) { e.highlights = Math.min(e.highlights, -35); e.hsl.blue.luminance = Math.min(e.hsl.blue.luminance, -8); e.hsl.blue.saturation = Math.max(e.hsl.blue.saturation, 6); notes.push('recovered sky'); }
  if (a.foliage > 0.15) { e.hsl.green.saturation = Math.min(e.hsl.green.saturation, -6); e.hsl.yellow.hue = Math.max(e.hsl.yellow.hue, 4); notes.push('natural greens'); }
  // Low-light: noise reduction for RAW
  if (isRaw && before.key < 0.32) { e.detail.noiseReduction = Math.max(e.detail.noiseReduction, Math.round(clamp((0.32 - before.key) * 120, 8, 30))); notes.push('noise reduction for low light'); }
  return { edit: e, analysis: a, notes };
}

/** Store action: enhance the current photo with a 0..1 strength. */
export function runAutoEnhance(strength = 0.7) {
  const h = host(), r = h.renderer;
  const dev = useDevelop.getState();
  if (!r?.source || dev.photoId == null) {
    useApp.getState().toast({ kind: 'info', title: 'Open a photo first', body: 'AI Auto Enhance works on the photo shown in Develop.' });
    return;
  }
  const base = cloneEdit(dev.edit);
  const { edit, notes } = computeEnhance(r, base, h.renderContext(base), dev.asShot, dev.isRaw);
  const next = blendEdits(base, edit, clamp(strength, 0, 1));
  next.wb.mode = 'auto';
  // Rounded values read better in the UI
  for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] as const) next[k] = Math.round(next[k]);
  next.exposure = Math.round(next.exposure * 100) / 100;
  dev.replaceEdit(next, `AI Auto Enhance ${Math.round(strength * 100)}%`, { aiEnhanced: true });
  h.requestRender();
  useApp.getState().toast({ kind: 'success', title: 'AI Auto Enhance applied', body: (notes.length ? notes.join(', ') + '. ' : '') + 'Every change is a regular slider you can adjust.' });
}
