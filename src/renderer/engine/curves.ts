import type { CurvePoint, ToneCurve } from '@shared/edit';

/** Monotone cubic (Fritsch–Carlson) interpolation through sorted control points. */
export function makeSpline(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  if (n < 2) return x => x;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-9));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-12) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/**
 * Parametric curve: four region sliders (-100..100) bounded by three split points.
 * Each region bends the curve with a smooth bump centered in its region.
 */
export function makeParametric(p: ToneCurve['parametric']): (x: number) => number {
  const [s1, s2, s3] = p.split;
  const regions = [
    { amt: p.shadows, lo: 0, hi: s1 },
    { amt: p.darks, lo: s1 * 0.5, hi: s2 },
    { amt: p.lights, lo: s2, hi: s3 + (1 - s3) * 0.5 },
    { amt: p.highlights, lo: s3, hi: 1 },
  ];
  if (regions.every(r => r.amt === 0)) return x => x;
  return (x: number) => {
    let y = x;
    for (const r of regions) {
      if (!r.amt) continue;
      const c = (r.lo + r.hi) / 2, w = Math.max((r.hi - r.lo) / 2 + 0.08, 0.05);
      const t = (x - c) / w;
      const bump = Math.exp(-t * t * 1.6) * x * (1 - x) * 4; // zero at endpoints
      y += (r.amt / 100) * 0.22 * bump;
    }
    return y;
  };
}

export const CURVE_LUT_SIZE = 1024;

/** RGBA float LUT: channel j = channelCurve_j(master(parametric(x))). */
export function buildCurveLut(curve: ToneCurve): Float32Array {
  const par = makeParametric(curve.parametric);
  const master = makeSpline(curve.rgb);
  const ch = [makeSpline(curve.red), makeSpline(curve.green), makeSpline(curve.blue)];
  const out = new Float32Array(CURVE_LUT_SIZE * 4);
  for (let i = 0; i < CURVE_LUT_SIZE; i++) {
    const x = i / (CURVE_LUT_SIZE - 1);
    const m = clamp01(master(clamp01(par(x))));
    for (let j = 0; j < 3; j++) out[i * 4 + j] = clamp01(ch[j](m));
    out[i * 4 + 3] = 1;
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  Linear: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  'Medium Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.21 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.79 }, { x: 1, y: 1 }],
  'Strong Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.17 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.84 }, { x: 1, y: 1 }],
  Matte: [{ x: 0, y: 0.09 }, { x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.8 }, { x: 1, y: 0.95 }],
  Soft: [{ x: 0, y: 0.03 }, { x: 0.3, y: 0.32 }, { x: 0.7, y: 0.68 }, { x: 1, y: 0.97 }],
  Film: [{ x: 0, y: 0.06 }, { x: 0.18, y: 0.15 }, { x: 0.5, y: 0.52 }, { x: 0.82, y: 0.86 }, { x: 1, y: 0.96 }],
  Fade: [{ x: 0, y: 0.14 }, { x: 0.35, y: 0.38 }, { x: 0.7, y: 0.7 }, { x: 1, y: 0.92 }],
};
