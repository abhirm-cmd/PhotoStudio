/**
 * Upright: automatic perspective and level correction.
 *
 * 1. Render the photo with lens corrections but without transform/straighten.
 * 2. Detect straight line segments (gradient-oriented Hough transform).
 * 3. Search Transform parameters (vertical, horizontal, rotate) that make
 *    near-vertical segments vertical and near-horizontal segments horizontal,
 *    using the engine's own transform matrix so the result matches the render.
 * Guided mode uses user-drawn guides instead of detected lines.
 */
import { host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { cloneEdit, defaultEdit, type EditParams, type Vec2 } from '@shared/edit';
import { transformMatrix, applyHom, computeGeometry } from '../engine/geometry';
import { frameGeometry, maxRectAt, cropAspect } from '../develop/crop';

export interface Segment { a: Vec2; b: Vec2; w: number; kind: 'v' | 'h' }

const deg = Math.PI / 180;

/** Detect line segments in a luminance image. Coordinates returned in pixels. */
export function detectSegments(lum: Float32Array, w: number, h: number, maxLines = 48): { a: Vec2; b: Vec2; votes: number }[] {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  let mmax = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const sx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
    const sy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
    gx[i] = sx; gy[i] = sy;
    const m = Math.hypot(sx, sy);
    mag[i] = m;
    if (m > mmax) mmax = m;
  }
  // Edge threshold: top ~8% of gradient magnitudes
  const sample = Array.from(mag).filter(v => v > 0).sort((a, b) => a - b);
  const thr = Math.max(mmax * 0.08, sample[Math.floor(sample.length * 0.92)] ?? 0);
  const T = 360; // theta bins over [0, 180)
  const diag = Math.ceil(Math.hypot(w, h));
  const R = 2 * diag + 1;
  const acc = new Uint32Array(T * R);
  const cosT = new Float32Array(T), sinT = new Float32Array(T);
  for (let t = 0; t < T; t++) { cosT[t] = Math.cos((t / T) * Math.PI); sinT[t] = Math.sin((t / T) * Math.PI); }
  const edges: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mag[i] < thr) continue;
    edges.push(i);
    const x = i % w, y = (i / w) | 0;
    let th = Math.atan2(gy[i], gx[i]); // normal direction
    if (th < 0) th += Math.PI;
    const tc = Math.round((th / Math.PI) * T);
    for (let d = -4; d <= 4; d++) {
      const t = (tc + d + T) % T;
      const rho = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      acc[t * R + rho]++;
    }
  }
  const minVotes = Math.max(14, Math.min(w, h) * 0.1);
  const peaks: { t: number; r: number; v: number }[] = [];
  for (let t = 0; t < T; t++) for (let r = 1; r < R - 1; r++) {
    const v = acc[t * R + r];
    if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -3; dt <= 3 && isMax; dt++) for (let dr = -3; dr <= 3; dr++) {
      if (!dt && !dr) continue;
      const tt = (t + dt + T) % T, rr = r + dr;
      if (rr < 0 || rr >= R) continue;
      if (acc[tt * R + rr] > v) { isMax = false; break; }
    }
    if (isMax) peaks.push({ t, r, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const out: { a: Vec2; b: Vec2; votes: number }[] = [];
  for (const pk of peaks.slice(0, maxLines * 2)) {
    const c = cosT[pk.t], s = sinT[pk.t], rho = pk.r - diag;
    // Collect inliers along the line, find the longest dense run
    const ts: number[] = [];
    for (const i of edges) {
      const x = i % w, y = (i / w) | 0;
      if (Math.abs(x * c + y * s - rho) > 1.5) continue;
      ts.push(-x * s + y * c);
    }
    if (ts.length < minVotes * 0.6) continue;
    ts.sort((a, b) => a - b);
    let best = [ts[0], ts[0]], bestN = 0, start = 0;
    for (let k = 1; k <= ts.length; k++) {
      if (k === ts.length || ts[k] - ts[k - 1] > 6) {
        if (k - start > bestN) { bestN = k - start; best = [ts[start], ts[k - 1]]; }
        start = k;
      }
    }
    const len = best[1] - best[0];
    if (len < Math.min(w, h) * 0.12 || bestN < len * 0.35) continue;
    const p = (t: number): Vec2 => [rho * c - t * s, rho * s + t * c];
    out.push({ a: p(best[0]), b: p(best[1]), votes: bestN });
    if (out.length >= maxLines) break;
  }
  return out;
}

/** Render the uncorrected (no transform/straighten/crop) image and detect line segments in normalized ideal coordinates. */
export function analyzeLines(): { segments: Segment[]; aspect: number } | null {
  const h = host(), r = h.renderer;
  const dev = useDevelop.getState();
  if (!r?.source) return null;
  const e = cloneEdit(dev.edit);
  e.transform = { ...defaultEdit().transform };
  e.crop = { ...e.crop, x: 0, y: 0, w: 1, h: 1, angle: 0 };
  e.masks = [];
  const rc = h.renderContext(e);
  const g = computeGeometry(e, r.source.width, r.source.height, rc.lens);
  const out = r.render(e, { ...rc, assets: new Map() }, { scale: Math.min(1, 640 / Math.max(g.outW, g.outH)), noMasks: true }, 'auto');
  const small = r.readSmall(out, 640);
  const lum = new Float32Array(small.w * small.h);
  for (let i = 0; i < lum.length; i++) lum[i] = Math.pow(Math.max(0, 0.2627 * small.data[i * 4] + 0.678 * small.data[i * 4 + 1] + 0.0593 * small.data[i * 4 + 2]), 1 / 2.2);
  const segs = detectSegments(lum, small.w, small.h);
  const k = g.frameW / small.w, hd = g.halfDiag;
  const norm = (p: Vec2): Vec2 => [((p[0] + 0.5) - small.w / 2) * k / hd, ((p[1] + 0.5) - small.h / 2) * k / hd];
  const segments: Segment[] = [];
  for (const s of segs) {
    const a = norm(s.a), b = norm(s.b);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const fromH = Math.abs(Math.sin(ang)), fromV = Math.abs(Math.cos(ang));
    if (fromV < Math.sin(28 * deg)) segments.push({ a, b, w: Math.hypot(b[0] - a[0], b[1] - a[1]), kind: 'v' });
    else if (fromH < Math.sin(18 * deg)) segments.push({ a, b, w: Math.hypot(b[0] - a[0], b[1] - a[1]), kind: 'h' });
  }
  return { segments, aspect: g.frameW / g.frameH };
}

interface Params { vertical: number; horizontal: number; rotate: number; angle: number }

function cost(segs: Segment[], p: Params, use: { v: boolean; h: boolean }, reg: number): number {
  const t = { ...defaultEdit().transform, vertical: p.vertical, horizontal: p.horizontal, rotate: p.rotate };
  const H = transformMatrix(t, 1);
  const ca = Math.cos(-p.angle * deg), sa = Math.sin(-p.angle * deg);
  const out = (q: Vec2): Vec2 => { const n = applyHom(H, q); return [ca * n[0] - sa * n[1], sa * n[0] + ca * n[1]]; };
  let c = 0, W = 0;
  const clip = (5 * deg) ** 2;
  for (const s of segs) {
    if ((s.kind === 'v' && !use.v) || (s.kind === 'h' && !use.h)) continue;
    const a = out(s.a), b = out(s.b);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const err = s.kind === 'v' ? Math.atan2(dx, Math.abs(dy) < 1e-9 ? 1e-9 : dy) : Math.atan2(dy, Math.abs(dx) < 1e-9 ? 1e-9 : dx);
    const e2 = Math.min(err * err, clip);
    c += e2 * s.w; W += s.w;
  }
  if (!W) return Infinity;
  return c / W + reg * ((p.vertical / 100) ** 2 + (p.horizontal / 100) ** 2) * 1e-3;
}

function search(segs: Segment[], free: (keyof Params)[], use: { v: boolean; h: boolean }, reg = 0, init?: Partial<Params>): Params {
  let p: Params = { vertical: 0, horizontal: 0, rotate: 0, angle: 0, ...init };
  const range: Record<keyof Params, [number, number]> = { vertical: [-100, 100], horizontal: [-100, 100], rotate: [-10, 10], angle: [-45, 45] };
  for (const stepScale of [8, 2, 0.5, 0.1]) {
    for (let pass = 0; pass < 3; pass++) {
      for (const k of free) {
        const [lo, hi] = range[k];
        const step = k === 'rotate' || k === 'angle' ? stepScale * 0.25 : stepScale;
        let best = p[k], bestC = cost(segs, p, use, reg);
        for (let d = -6; d <= 6; d++) {
          const v = Math.min(hi, Math.max(lo, p[k] + d * step));
          const c = cost(segs, { ...p, [k]: v }, use, reg);
          if (c < bestC - 1e-12) { bestC = c; best = v; }
        }
        p = { ...p, [k]: best };
      }
    }
  }
  return p;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Apply new transform values and re-fit the crop so no empty corners show. */
function applyTransform(label: string, mode: EditParams['transform']['upright'], t: Partial<EditParams['transform']>) {
  const dev = useDevelop.getState();
  const src = host().renderer?.source;
  dev.setEdit(e => {
    Object.assign(e.transform, { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 }, t, { upright: mode });
    if (src) {
      const g = frameGeometry(e, src.width, src.height, host().renderContext(e).lens);
      const asp = cropAspect(e, g) ?? (e.crop.w * g.frameW) / (e.crop.h * g.frameH);
      Object.assign(e.crop, maxRectAt(g, 0.5, 0.5, asp));
    }
  }, label);
}

export async function runUpright(mode: 'auto' | 'level' | 'vertical' | 'full') {
  const app = useApp.getState();
  await new Promise(r => setTimeout(r, 16));
  const res = analyzeLines();
  if (!res) return;
  const { segments } = res;
  const nv = segments.filter(s => s.kind === 'v').length, nh = segments.filter(s => s.kind === 'h').length;
  if (nv + nh < 2) {
    app.toast({ kind: 'info', title: 'Not enough straight lines found', body: 'Try Guided Upright and draw guides along lines that should be straight.' });
    return;
  }
  let p: Params;
  if (mode === 'level') p = search(segments, ['rotate'], { v: true, h: true });
  else if (mode === 'vertical') p = search(segments, ['vertical', 'rotate'], { v: true, h: nv < 2 });
  else if (mode === 'full') p = search(segments, ['vertical', 'horizontal', 'rotate'], { v: true, h: true });
  else {
    // Auto: balanced correction, damped so it never looks extreme
    p = search(segments, ['vertical', 'horizontal', 'rotate'], { v: true, h: true }, 40);
    p.vertical *= 0.85; p.horizontal *= 0.7;
  }
  applyTransform(`Upright: ${mode[0].toUpperCase() + mode.slice(1)}`, mode, { vertical: round(p.vertical, 0), horizontal: round(p.horizontal, 0), rotate: round(p.rotate, 2) });
  app.toast({ kind: 'success', title: `Upright ${mode} applied`, body: `Measured ${nv} vertical and ${nh} horizontal lines. Fine-tune with the sliders.` });
}

/** Solve from user-drawn guides (normalized ideal coordinates). */
export function solveGuided(guides: { a: Vec2; b: Vec2 }[]) {
  const segs: Segment[] = guides.map(g => {
    const ang = Math.atan2(g.b[1] - g.a[1], g.b[0] - g.a[0]);
    return { a: g.a, b: g.b, w: 1, kind: Math.abs(Math.cos(ang)) < Math.abs(Math.sin(ang)) ? 'v' : 'h' };
  });
  const nv = segs.filter(s => s.kind === 'v').length, nh = segs.length - nv;
  const free: (keyof Params)[] = ['rotate'];
  if (nv >= 2) free.push('vertical');
  if (nh >= 2) free.push('horizontal');
  if (nv === 1 && nh === 1) free.push('vertical');
  const p = search(segs, free, { v: true, h: true });
  applyTransform('Upright: Guided', 'guided', { vertical: round(p.vertical, 0), horizontal: round(p.horizontal, 0), rotate: round(p.rotate, 2), guides: guides as any });
}

/** Best straighten (crop angle) from detected horizon / verticals. */
export async function autoStraightenAngle(): Promise<number | null> {
  await new Promise(r => setTimeout(r, 16));
  const res = analyzeLines();
  if (!res || res.segments.length < 1) return null;
  const t = useDevelop.getState().edit.transform;
  const p = search(res.segments, ['angle'], { v: true, h: true }, 0, { vertical: t.vertical, horizontal: t.horizontal, rotate: t.rotate });
  return Math.abs(p.angle) < 0.05 ? 0 : round(p.angle, 2);
}
