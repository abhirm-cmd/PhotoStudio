/**
 * Reference Grade — match the look of a reference image.
 *
 * 1. Both images are rendered through the real pipeline and measured in
 *    perceptual space: tonal quantiles, contrast, black/white points, colour
 *    cast per tonal zone, saturation and per-hue colour statistics, palette.
 * 2. A normal, editable Lumora edit is fitted to the target photo with a
 *    closed loop: apply → re-render → re-measure → correct. Tone is matched
 *    with exposure and a quantile-matched tone curve, colour with 3-way grading
 *    wheels, saturation/vibrance and the HSL mixer.
 * 3. The result is blended with the photo's original settings by Strength, and
 *    can be saved as a regular preset (Color Only or Full Grade).
 */
import { normalizeEdit, cloneEdit, blendEdits, defaultEdit, linearCurve, HSL_CHANNELS, type EditParams, type CurvePoint } from '@shared/edit';
import { convertMatrix, SPACES, linearSrgbToOklab, HSL_CENTERS, hexFromLinearSrgb } from '@shared/color';
import type { Renderer, RenderContext, SourceImage } from '../engine/pipeline';
import { computeGeometry } from '../engine/geometry';
import { offscreen, prepare, contextFor, loadMaskAssets } from '../services/offscreen';
import { loadReference } from '../decode/sources';
import { encodeJpeg } from '../engine/host';
import { api } from '../api';
import type { Photo } from '@shared/types';

export interface LookStats {
  /** Quantiles of luminance in tone-curve space (gamma 2.2 encoded) */
  q: number[];
  medianLin: number;
  contrast: number;
  /** Median OkLab a/b per zone: shadows, midtones, highlights, overall */
  zones: { a: number; b: number; n: number }[];
  chroma: number;
  chromaP90: number;
  /** Per HSL band: share of colourful pixels, mean chroma, mean L, circular mean hue */
  bands: { share: number; chroma: number; L: number; hue: number }[];
  palette: { hex: string; share: number }[];
  key: number;
}

export const QS = [0.005, 0.02, 0.06, 0.15, 0.3, 0.5, 0.7, 0.85, 0.94, 0.98, 0.995];

const toSrgb = convertMatrix(SPACES.rec2020, SPACES.srgb);

export function measureLook(data: Float32Array): LookStats {
  const n = data.length / 4;
  const Ys: number[] = [];
  const Ls: number[] = [], As: number[] = [], Bs: number[] = [];
  const cs: number[] = [];
  const bandAcc = HSL_CENTERS.map(() => ({ n: 0, c: 0, L: 0, sx: 0, sy: 0 }));
  const palette = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 0.5) continue;
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    const Y = Math.max(0, 0.2627 * R + 0.678 * G + 0.0593 * B);
    Ys.push(Y);
    const lin: [number, number, number] = [
      Math.min(1, Math.max(0, toSrgb[0] * R + toSrgb[1] * G + toSrgb[2] * B)),
      Math.min(1, Math.max(0, toSrgb[3] * R + toSrgb[4] * G + toSrgb[5] * B)),
      Math.min(1, Math.max(0, toSrgb[6] * R + toSrgb[7] * G + toSrgb[8] * B)),
    ];
    const [L, a, b] = linearSrgbToOklab(lin);
    Ls.push(L); As.push(a); Bs.push(b);
    const C = Math.hypot(a, b);
    cs.push(C);
    if (C > 0.03) {
      const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
      // nearest band
      let bi = 0, bd = 999;
      HSL_CENTERS.forEach((c, k) => { const d = Math.min(Math.abs(h - c), 360 - Math.abs(h - c)); if (d < bd) { bd = d; bi = k; } });
      const acc = bandAcc[bi];
      acc.n++; acc.c += C; acc.L += L; acc.sx += Math.cos((h * Math.PI) / 180); acc.sy += Math.sin((h * Math.PI) / 180);
    }
    const key = (Math.round(lin[0] * 7) << 6) | (Math.round(lin[1] * 7) << 3) | Math.round(lin[2] * 7);
    const pb = palette.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    pb.n++; pb.r += lin[0]; pb.g += lin[1]; pb.b += lin[2];
    palette.set(key, pb);
  }
  const N = Math.max(1, Ys.length);
  const enc = Ys.map(y => Math.pow(y, 1 / 2.2)).sort((a, b) => a - b);
  const q = QS.map(p => enc[Math.min(enc.length - 1, Math.floor(p * enc.length))] ?? 0);
  const sortedY = [...Ys].sort((a, b) => a - b);
  const mean = enc.reduce((s, v) => s + v, 0) / N;
  const sd = Math.sqrt(enc.reduce((s, v) => s + (v - mean) ** 2, 0) / N);
  const median = (arr: number[]) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const zone = (lo: number, hi: number) => {
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < Ls.length; i++) if (Ls[i] >= lo && Ls[i] < hi) { a.push(As[i]); b.push(Bs[i]); }
    return { a: median(a), b: median(b), n: a.length / N };
  };
  const sc = [...cs].sort((a, b) => a - b);
  return {
    q, medianLin: sortedY[Math.floor(sortedY.length / 2)] ?? 0.18, contrast: sd,
    zones: [zone(0, 0.42), zone(0.42, 0.72), zone(0.72, 1.01), zone(0, 1.01)],
    chroma: cs.reduce((s, v) => s + v, 0) / N, chromaP90: sc[Math.floor(sc.length * 0.9)] ?? 0,
    bands: bandAcc.map(b => ({ share: b.n / N, chroma: b.n ? b.c / b.n : 0, L: b.n ? b.L / b.n : 0, hue: b.n ? ((Math.atan2(b.sy, b.sx) * 180) / Math.PI + 360) % 360 : 0 })),
    palette: [...palette.values()].sort((x, y) => y.n - x.n).slice(0, 6).map(p => ({ hex: hexFromLinearSrgb([p.r / p.n, p.g / p.n, p.b / p.n]), share: p.n / N })),
    key: median(Ls),
  };
}

export function describeLook(s: LookStats): string[] {
  const t: string[] = [];
  t.push(s.key > 0.68 ? 'High-key' : s.key < 0.42 ? 'Low-key' : 'Balanced exposure');
  t.push(s.contrast > 0.24 ? 'Contrasty' : s.contrast < 0.15 ? 'Soft contrast' : 'Moderate contrast');
  if (s.q[0] > 0.08) t.push('Faded blacks');
  if (s.q[QS.length - 1] < 0.88) t.push('Muted highlights');
  t.push(s.chroma > 0.085 ? 'Vibrant' : s.chroma < 0.045 ? 'Muted color' : 'Natural color');
  const [sh, , hi] = s.zones;
  if (s.zones[3].b > 0.012) t.push('Warm');
  else if (s.zones[3].b < -0.012) t.push('Cool');
  if (Math.hypot(sh.a, sh.b) > 0.012 && Math.hypot(hi.a, hi.b) > 0.012 && Math.cos(Math.atan2(sh.b, sh.a) - Math.atan2(hi.b, hi.a)) < 0) t.push('Split-toned');
  return t;
}

/* ----------------------------------------------------------- rendering */

function renderSmall(r: Renderer, e: EditParams, rc: RenderContext, edge = 256) {
  const src = r.source!;
  const g = computeGeometry(e, src.width, src.height, rc.lens);
  const out = r.render(e, rc, { scale: Math.min(1, edge / Math.max(g.outW, g.outH)) }, 'refgrade');
  return r.readSmall(out, edge);
}

export interface ReferenceImage { label: string; url: string; stats: LookStats; source: { kind: 'file'; path: string } | { kind: 'photo'; id: number } }

/** Render and analyse a reference: a file (any supported format, incl. RAW) or a catalog photo with its current edit. */
export async function loadReferenceImage(ref: { kind: 'file'; path: string } | { kind: 'photo'; photo: Photo }): Promise<ReferenceImage> {
  return offscreen(async r => {
    let edit: EditParams, rc: RenderContext;
    let label: string;
    if (ref.kind === 'file') {
      const src = await loadReference(ref.path, 1600) as SourceImage;
      r.setSource(src);
      edit = defaultEdit(src.isRaw);
      edit.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
      rc = { lens: null, assets: new Map() };
      label = ref.path.split(/[\\/]/).pop() ?? 'Reference';
    } else {
      const p = ref.photo;
      const src = await prepare(r, p, 'preview', 1600);
      edit = normalizeEdit(await api.getEdit(p.id), p.isRaw);
      if (edit.wb.mode === 'asShot') edit.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
      rc = contextFor(p, edit, src.width, src.height, await loadMaskAssets(edit, p.id));
      label = p.filename;
    }
    const small = renderSmall(r, edit, rc, 320);
    const src = r.source!;
    const g = computeGeometry(edit, src.width, src.height, rc.lens);
    const big = r.render(edit, rc, { scale: Math.min(1, 1200 / Math.max(g.outW, g.outH)) }, 'refgrade-big');
    const jpg = await encodeJpeg(r.readEncoded(big, 'srgb', 8) as Uint8Array, big.width, big.height, 0.88);
    return { label, url: URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' })), stats: measureLook(small.data), source: ref.kind === 'file' ? { kind: 'file', path: ref.path } : { kind: 'photo', id: ref.photo.id } };
  });
}

/* ---------------------------------------------------------------- fitting */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function monotoneCurve(pts: CurvePoint[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  let lastY = -1;
  for (const p of pts.sort((a, b) => a.x - b.x)) {
    if (out.length && p.x - out[out.length - 1].x < 0.03) continue;
    const y = Math.max(lastY + 0.004, p.y);
    out.push({ x: p.x, y: clamp(y, 0, 1) });
    lastY = y;
  }
  return out;
}

export interface GradeResult { edit: EditParams; target: LookStats; result: LookStats; notes: string[] }

/** Fit an edit that moves `photo` (starting from `base`) toward `ref`. Runs on the offscreen renderer. */
export async function fitGrade(photo: Photo, base: EditParams, ref: LookStats, mode: 'color' | 'full'): Promise<GradeResult> {
  return offscreen(async r => {
    const src = await prepare(r, photo, 'preview', 1600);
    let e = cloneEdit(base);
    if (e.wb.mode === 'asShot') e.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
    const rc = contextFor(photo, e, src.width, src.height, await loadMaskAssets(e, photo.id));
    const measure = (x: EditParams) => measureLook(renderSmall(r, x, rc).data);
    const target = measure(e);
    const notes: string[] = [];

    if (mode === 'full') {
      // 1. Exposure: match median luminance
      for (let i = 0; i < 3; i++) {
        const m = measure(e);
        const d = Math.log2(Math.max(ref.medianLin, 1e-4) / Math.max(m.medianLin, 1e-4)) * 0.85;
        if (Math.abs(d) < 0.03) break;
        e.exposure = Math.round(clamp(e.exposure + d, -4, 4) * 100) / 100;
      }
      // 2. Tone curve: quantile matching in curve space (preserves the existing curve by composing)
      e.curve.rgb = linearCurve();
      for (let i = 0; i < 2; i++) {
        const m = measure(e);
        const pts: CurvePoint[] = [{ x: 0, y: clamp(ref.q[0] - m.q[0], 0, 0.25) }];
        QS.forEach((_, k) => { if (k === 0 || k === QS.length - 1) return; pts.push({ x: m.q[k], y: ref.q[k] }); });
        const top = m.q[QS.length - 1];
        pts.push({ x: 1, y: clamp(1 - (top - ref.q[QS.length - 1]), 0.75, 1) });
        // Compose with the current rgb curve
        const cur = e.curve.rgb;
        const evalCur = (x: number) => { for (let j = 1; j < cur.length; j++) if (x <= cur[j].x) { const t = (x - cur[j - 1].x) / Math.max(1e-6, cur[j].x - cur[j - 1].x); return cur[j - 1].y + (cur[j].y - cur[j - 1].y) * t; } return cur[cur.length - 1].y; };
        const inv = (y: number) => { let lo = 0, hi = 1; for (let j = 0; j < 30; j++) { const mid = (lo + hi) / 2; if (evalCur(mid) < y) lo = mid; else hi = mid; } return (lo + hi) / 2; };
        const composed = pts.map(p => ({ x: p.x === 0 || p.x === 1 ? p.x : inv(p.x), y: p.y }));
        // Damp toward identity for robustness
        e.curve.rgb = monotoneCurve(composed.map(p => ({ x: p.x, y: p.x + (p.y - p.x) * 0.9 })));
      }
      const m = measure(e);
      if (ref.q[0] > 0.06) notes.push('lifted blacks');
      if (Math.abs(m.contrast - target.contrast) > 0.02) notes.push(m.contrast > target.contrast ? 'more contrast' : 'softer contrast');
    }

    // 3. Saturation / vibrance (closed loop on mean chroma)
    for (let i = 0; i < 3; i++) {
      const m = measure(e);
      const ratio = ref.chroma / Math.max(1e-4, m.chroma);
      if (Math.abs(ratio - 1) < 0.04) break;
      const d = clamp((ratio - 1) * 70, -40, 40);
      // vibrance for boosts (protects already-saturated colours), saturation for reductions
      if (d > 0) e.vibrance = Math.round(clamp(e.vibrance + d * 0.8, -100, 100));
      else e.saturation = Math.round(clamp(e.saturation + d, -100, 100));
    }

    // 4. Colour cast per tonal zone with grading wheels (closed loop)
    const setWheel = (k: 'shadows' | 'midtones' | 'highlights', da: number, db: number) => {
      const w = e.grading[k];
      const ca = Math.cos((w.hue * Math.PI) / 180) * (w.sat / 100) * 0.06 + da, cb = Math.sin((w.hue * Math.PI) / 180) * (w.sat / 100) * 0.06 + db;
      const sat = clamp((Math.hypot(ca, cb) / 0.06) * 100, 0, 70);
      e.grading[k] = { ...w, hue: Math.round(((Math.atan2(cb, ca) * 180) / Math.PI + 360) % 360), sat: Math.round(sat * 10) / 10 };
    };
    for (let i = 0; i < 4; i++) {
      const m = measure(e);
      let moved = 0;
      (['shadows', 'midtones', 'highlights'] as const).forEach((k, z) => {
        if (ref.zones[z].n < 0.02 || m.zones[z].n < 0.02) return;
        let da = (ref.zones[z].a - m.zones[z].a) * 0.9, db = (ref.zones[z].b - m.zones[z].b) * 0.9;
        // Tint toward the reference's own cast; the perpendicular part of the difference mostly comes
        // from scene content (green foliage vs orange sand) and would push toward unrelated hues.
        const ra = ref.zones[z].a, rb = ref.zones[z].b, rl = Math.hypot(ra, rb);
        if (rl > 0.008) {
          const ux = ra / rl, uy = rb / rl;
          // Never tint away from the reference's own cast (that happens when the photo's content is more saturated than the reference's)
          const along = Math.max(0, da * ux + db * uy), perp = (-da * uy + db * ux) * 0.25;
          da = along * ux - perp * uy; db = along * uy + perp * ux;
        }
        moved += Math.hypot(da, db);
        setWheel(k, da, db);
      });
      if (moved < 0.002) break;
    }
    e.grading.blending = 60;
    const zn = ['shadows', 'midtones', 'highlights'] as const;
    zn.forEach(k => { if (e.grading[k].sat > 4) notes.push(`${k} toward ${hueName(e.grading[k].hue)}`); });

    // 5. Per-hue colour (HSL mixer), weighted by how much of each colour both images contain
    const m5 = measure(e);
    HSL_CHANNELS.forEach((ch, i) => {
      const rb = ref.bands[i], tb = m5.bands[i];
      if (rb.share < 0.02 || tb.share < 0.02) return;
      const conf = Math.min(1, Math.min(rb.share, tb.share) / 0.08) * 0.7;
      const satD = clamp(((rb.chroma / Math.max(1e-4, tb.chroma)) - 1) * 90 * conf, -60, 60);
      const lumD = clamp((rb.L - tb.L) * 220 * conf, -50, 50);
      let hd = rb.hue - tb.hue; if (hd > 180) hd -= 360; if (hd < -180) hd += 360;
      const hueD = clamp(hd * 1.6 * conf, -35, 35);
      e.hsl[ch] = { hue: Math.round(e.hsl[ch].hue + hueD), saturation: Math.round(clamp(e.hsl[ch].saturation + satD, -100, 100)), luminance: Math.round(clamp(e.hsl[ch].luminance + lumD, -100, 100)) };
    });

    const result = measure(e);
    return { edit: e, target, result, notes };
  });
}

function hueName(h: number) {
  const names: [number, string][] = [[15, 'red'], [45, 'orange'], [70, 'gold'], [105, 'yellow'], [150, 'green'], [190, 'teal'], [230, 'cyan-blue'], [265, 'blue'], [300, 'purple'], [340, 'magenta'], [361, 'red']];
  return names.find(([lim]) => h < lim)?.[1] ?? 'red';
}

/** Groups included for each mode — also used when saving as a preset. */
export const COLOR_ONLY_GROUPS = ['presence', 'hsl', 'grading'] as const;
export const FULL_GROUPS = ['tone', 'presence', 'toneCurve', 'hsl', 'grading'] as const;

/** Final edit for a strength: blend between the starting edit and the fitted grade, limited to the mode's groups. */
export function gradedEdit(base: EditParams, fitted: EditParams, strength: number, mode: 'color' | 'full'): EditParams {
  const b = cloneEdit(base);
  const f = cloneEdit(base);
  const keys = mode === 'color' ? ['vibrance', 'saturation', 'hsl', 'grading'] : ['exposure', 'vibrance', 'saturation', 'curve', 'hsl', 'grading'];
  for (const k of keys) (f as any)[k] = structuredClone((fitted as any)[k]);
  return blendEdits(b, f, clamp(strength, 0, 1.5));
}
