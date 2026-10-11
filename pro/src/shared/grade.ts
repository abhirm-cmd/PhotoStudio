/**
 * Color grading model for clips (primary wheels, curves, LUT) and the 3D LUT
 * it bakes into. The same baked LUT drives the GPU preview (3D texture) and
 * the export (FFmpeg lut3d), so what you see is what you render.
 *
 * All operations work on display-encoded Rec.709 RGB in 0..1, like the
 * primaries in most grading applications.
 */

export interface Wheel { x: number; y: number; m: number }   // x,y in the unit disk (color), m = master -1..1
export interface CurvePoint { x: number; y: number }
export interface Curves { master: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }
export interface LutRef { path: string; name: string; strength: number }

export interface Grade {
  bypass: boolean;
  exposure: number;      // stops, -4..4
  temperature: number;   // -100..100 (cool..warm)
  tint: number;          // -100..100 (green..magenta)
  contrast: number;      // -100..100
  pivot: number;         // 0..1
  saturation: number;    // 0..200 (%)
  lift: Wheel;
  gamma: Wheel;
  gain: Wheel;
  offset: Wheel;
  curves: Curves;
  lut: LutRef | null;
}

const zero = (): Wheel => ({ x: 0, y: 0, m: 0 });
export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

export const defaultGrade = (): Grade => ({
  bypass: false, exposure: 0, temperature: 0, tint: 0, contrast: 0, pivot: 0.435, saturation: 100,
  lift: zero(), gamma: zero(), gain: zero(), offset: zero(),
  curves: { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
  lut: null,
});

const isIdentityCurve = (c: CurvePoint[]) => c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
const wheelZero = (w: Wheel) => !w.x && !w.y && !w.m;

export function isNeutral(g: Grade): boolean {
  return g.bypass || (!g.exposure && !g.temperature && !g.tint && !g.contrast && g.saturation === 100 &&
    wheelZero(g.lift) && wheelZero(g.gamma) && wheelZero(g.gain) && wheelZero(g.offset) &&
    isIdentityCurve(g.curves.master) && isIdentityCurve(g.curves.r) && isIdentityCurve(g.curves.g) && isIdentityCurve(g.curves.b) && !g.lut);
}

/** Wheel position → RGB offset. Hue goes around the disk (0° = red); balanced so it doesn't change luma much. */
export function wheelRgb(w: Wheel): [number, number, number] {
  const a = Math.atan2(w.y, w.x), d = Math.min(1, Math.hypot(w.x, w.y));
  const k = (o: number) => d * Math.cos(a - o) * (2 / 3);
  return [k(0), k((2 * Math.PI) / 3), k((4 * Math.PI) / 3)];
}

/* ------------------------------------------------------------- curves */

/** Monotone cubic interpolation (Fritsch–Carlson) sampled into a table. */
export function curveTable(pts: CurvePoint[], n = 1024): Float32Array {
  const p = [...pts].sort((a, b) => a.x - b.x);
  const out = new Float32Array(n);
  if (p.length < 2) { for (let i = 0; i < n; i++) out[i] = i / (n - 1); return out; }
  const k = p.length;
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < k - 1; i++) { dx.push(Math.max(1e-6, p[i + 1].x - p[i].x)); m.push((p[i + 1].y - p[i].y) / dx[i]); }
  const t: number[] = [m[0]];
  for (let i = 1; i < k - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[k - 2]);
  for (let i = 0; i < k - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const s = 3 / Math.sqrt(h); t[i] = s * a * m[i]; t[i + 1] = s * b * m[i]; }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= p[0].x) { out[j] = p[0].y; continue; }
    if (x >= p[k - 1].x) { out[j] = p[k - 1].y; continue; }
    while (seg < k - 2 && x > p[seg + 1].x) seg++;
    const h = dx[seg], s = (x - p[seg].x) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    out[j] = Math.min(1, Math.max(0, h00 * p[seg].y + h10 * h * t[seg] + h01 * p[seg + 1].y + h11 * h * t[seg + 1]));
  }
  return out;
}

const lookup = (t: Float32Array, v: number) => {
  const x = Math.min(1, Math.max(0, v)) * (t.length - 1), i = Math.floor(x), f = x - i;
  return i >= t.length - 1 ? t[t.length - 1] : t[i] + (t[i + 1] - t[i]) * f;
};

/* ---------------------------------------------------------------- LUTs */

export interface Lut3D { size: number; data: Float32Array; title?: string }  // data: RGB triplets, R fastest

export function parseCube(text: string): Lut3D {
  let size = 0, title: string | undefined;
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.replace(/^TITLE\s+/i, '').replace(/^"|"$/g, ''); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported; use a 3D .cube LUT.');
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 3 && nums.every(Number.isFinite)) vals.push(nums[0], nums[1], nums[2]);
  }
  if (!size || vals.length !== size ** 3 * 3) throw new Error(`Invalid .cube file (expected ${size ** 3} entries, found ${vals.length / 3}).`);
  const data = new Float32Array(vals);
  // Normalize custom domains to 0..1 output
  if (dmin.some(v => v !== 0) || dmax.some(v => v !== 1)) {
    for (let i = 0; i < data.length; i++) { const c = i % 3; data[i] = (data[i] - dmin[c]) / (dmax[c] - dmin[c]); }
  }
  return { size, data, title };
}

export function sampleLut(l: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = l.size - 1;
  const fx = Math.min(1, Math.max(0, r)) * n, fy = Math.min(1, Math.max(0, g)) * n, fz = Math.min(1, Math.max(0, b)) * n;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = Math.min(n, x0 + 1), y1 = Math.min(n, y0 + 1), z1 = Math.min(n, z0 + 1);
  const dx = fx - x0, dy = fy - y0, dz = fz - z0;
  const at = (x: number, y: number, z: number, c: number) => l.data[((z * l.size + y) * l.size + x) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - dx) + at(x1, y0, z0, c) * dx;
    const c10 = at(x0, y1, z0, c) * (1 - dx) + at(x1, y1, z0, c) * dx;
    const c01 = at(x0, y0, z1, c) * (1 - dx) + at(x1, y0, z1, c) * dx;
    const c11 = at(x0, y1, z1, c) * (1 - dx) + at(x1, y1, z1, c) * dx;
    out[c] = (c00 * (1 - dy) + c10 * dy) * (1 - dz) + (c01 * (1 - dy) + c11 * dy) * dz;
  }
  return out;
}

export function writeCube(l: Lut3D, title = 'PhotoStudio Pro grade'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${l.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < l.data.length; i += 3) lines.push(`${l.data[i].toFixed(6)} ${l.data[i + 1].toFixed(6)} ${l.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------- the grade */

const toLin = (v: number) => (v <= 0 ? 0 : Math.pow(v, 2.4));
const toEnc = (v: number) => (v <= 0 ? 0 : Math.pow(v, 1 / 2.4));

/** Returns a function that grades one display-encoded RGB triple. */
export function gradeFn(g: Grade, lut?: Lut3D | null): (r: number, gr: number, b: number) => [number, number, number] {
  if (g.bypass) return (r, gg, b) => [r, gg, b];
  const ev = Math.pow(2, g.exposure);
  // White balance as gains in linear light: temperature along blue↔amber, tint along green↔magenta
  const t = g.temperature / 100, ti = g.tint / 100;
  const wb = [Math.pow(2, 0.35 * t + 0.1 * ti), Math.pow(2, -0.25 * ti), Math.pow(2, -0.45 * t + 0.1 * ti)];
  const off = wheelRgb(g.offset).map(v => v * 0.2 + g.offset.m * 0.2);
  const lift = wheelRgb(g.lift).map(v => v * 0.3 + g.lift.m * 0.3);
  const gain = wheelRgb(g.gain).map(v => 1 + v * 0.6 + g.gain.m * 0.6);
  const gam = wheelRgb(g.gamma).map(v => Math.pow(2, -(v * 0.8 + g.gamma.m * 0.8)));
  const c = 1 + g.contrast / 100;
  const s = g.saturation / 100;
  const cm = curveTable(g.curves.master), cr = curveTable(g.curves.r), cg = curveTable(g.curves.g), cb = curveTable(g.curves.b);
  const curvesOn = ![g.curves.master, g.curves.r, g.curves.g, g.curves.b].every(isIdentityCurve);
  const strength = g.lut?.strength ?? 1;
  return (r, gg, b) => {
    let v = [r, gg, b];
    if (g.exposure || g.temperature || g.tint) v = v.map((x, i) => toEnc(toLin(x) * ev * wb[i]));
    for (let i = 0; i < 3; i++) {
      let x = v[i] + off[i];
      x = gain[i] * (x + lift[i] * (1 - x));
      x = x > 0 ? Math.pow(x, gam[i]) : x;
      x = (x - g.pivot) * c + g.pivot;
      v[i] = x;
    }
    if (s !== 1) {
      const y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      v = v.map(x => y + (x - y) * s);
    }
    if (curvesOn) v = [lookup(cr, lookup(cm, v[0])), lookup(cg, lookup(cm, v[1])), lookup(cb, lookup(cm, v[2]))];
    if (lut) {
      const o = sampleLut(lut, v[0], v[1], v[2]);
      v = v.map((x, i) => x + (o[i] - x) * strength);
    }
    return [Math.min(1, Math.max(0, v[0])), Math.min(1, Math.max(0, v[1])), Math.min(1, Math.max(0, v[2]))];
  };
}

/** Bake a grade (and optional imported LUT) into a 3D LUT. */
export function bakeLut(g: Grade, lut?: Lut3D | null, size = 33): Lut3D {
  const f = gradeFn(g, lut);
  const data = new Float32Array(size ** 3 * 3);
  const n = size - 1;
  let i = 0;
  for (let b = 0; b < size; b++) for (let gg = 0; gg < size; gg++) for (let r = 0; r < size; r++) {
    const o = f(r / n, gg / n, b / n);
    data[i++] = o[0]; data[i++] = o[1]; data[i++] = o[2];
  }
  return { size, data };
}

/** Stable key for caching a baked LUT. */
export const gradeKey = (g: Grade) => JSON.stringify(g);
