/**
 * Colorimetry utilities shared by the render engine, ICC writer and analysis code.
 * Matrices are row-major 3x3 arrays (number[9]).
 */

export type Mat3 = number[];
export type Vec3 = [number, number, number];
export type XY = [number, number];

export interface RgbSpace { id: string; name: string; r: XY; g: XY; b: XY; white: XY; gamma: 'srgb' | number }

export const WHITE_D65: XY = [0.31271, 0.32902];
export const WHITE_D50: XY = [0.34567, 0.35850];

export const SPACES: Record<string, RgbSpace> = {
  srgb: { id: 'srgb', name: 'sRGB IEC61966-2.1', r: [0.64, 0.33], g: [0.30, 0.60], b: [0.15, 0.06], white: WHITE_D65, gamma: 'srgb' },
  'display-p3': { id: 'display-p3', name: 'Display P3', r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: WHITE_D65, gamma: 'srgb' },
  'adobe-rgb': { id: 'adobe-rgb', name: 'Adobe RGB (1998) compatible', r: [0.64, 0.33], g: [0.21, 0.71], b: [0.15, 0.06], white: WHITE_D65, gamma: 563 / 256 },
  prophoto: { id: 'prophoto', name: 'ProPhoto RGB (ROMM) compatible', r: [0.7347, 0.2653], g: [0.1596, 0.8404], b: [0.0366, 0.0001], white: WHITE_D50, gamma: 1.8 },
  rec2020: { id: 'rec2020', name: 'Rec. 2020 linear', r: [0.708, 0.292], g: [0.170, 0.797], b: [0.131, 0.046], white: WHITE_D65, gamma: 1 },
};

export const WORKING_SPACE = SPACES.rec2020;

export const xyToXYZ = ([x, y]: XY, Y = 1): Vec3 => [(x * Y) / y, Y, ((1 - x - y) * Y) / y];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}
export function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const id = 1 / det;
  return [A * id, -(b * i - c * h) * id, (b * f - c * e) * id, B * id, (a * i - c * g) * id, -(a * f - c * d) * id, C * id, -(a * h - b * g) * id, (a * e - b * d) * id];
}
export const diag = (v: Vec3): Mat3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** RGB → XYZ matrix for a set of primaries and white point. */
export function rgbToXyz(s: RgbSpace): Mat3 {
  const [xr, yr, zr] = xyToXYZ(s.r), [xg, yg, zg] = xyToXYZ(s.g), [xb, yb, zb] = xyToXYZ(s.b);
  const P: Mat3 = [xr, xg, xb, yr, yg, yb, zr, zg, zb];
  const S = mulVec(inv(P), xyToXYZ(s.white));
  return mul(P, diag(S));
}

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/** Bradford chromatic adaptation from one white (XYZ) to another. */
export function bradford(src: Vec3, dst: Vec3): Mat3 {
  const s = mulVec(BRADFORD, src), d = mulVec(BRADFORD, dst);
  return mul(inv(BRADFORD), mul(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
}

/** Matrix converting linear RGB in `from` to linear RGB in `to`, with Bradford adaptation between whites. */
export function convertMatrix(from: RgbSpace, to: RgbSpace): Mat3 {
  let m = rgbToXyz(from);
  if (from.white[0] !== to.white[0] || from.white[1] !== to.white[1]) m = mul(bradford(xyToXYZ(from.white), xyToXYZ(to.white)), m);
  return mul(inv(rgbToXyz(to)), m);
}

/** RGB→XYZ adapted to D50 (ICC PCS). */
export function rgbToXyzD50(s: RgbSpace): Mat3 {
  const m = rgbToXyz(s);
  return s.white === WHITE_D50 ? m : mul(bradford(xyToXYZ(s.white), xyToXYZ(WHITE_D50)), m);
}

/* ------------------------------------------------------------- transfer */

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);

/* --------------------------------------------------- white balance model */

/** Planckian locus chromaticity (Kim et al. 2002 cubic spline), valid 1667K..25000K. */
export function planckXY(T: number): XY {
  T = Math.min(25000, Math.max(1667, T));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.179910 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const xyToUv = ([x, y]: XY): XY => { const d = -2 * x + 12 * y + 3; return [(4 * x) / d, (6 * y) / d]; };
const uvToXy = ([u, v]: XY): XY => { const d = 2 * u - 8 * v + 4; return [(3 * u) / d, (2 * v) / d]; };

/** Illuminant chromaticity for a temperature and tint (tint>0 = greener illuminant → magenta correction). */
export function illuminantXY(T: number, tint: number): XY {
  const uv = xyToUv(planckXY(T));
  const uv2 = xyToUv(planckXY(T * 1.01));
  // Normal to the locus in uv (pointing toward green, i.e. increasing v).
  let nx = -(uv2[1] - uv[1]), ny = uv2[0] - uv[0];
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const k = (tint / 150) * 0.05;
  return uvToXy([uv[0] + nx * k, uv[1] + ny * k]);
}

/** Working-space matrix that adapts an image lit by (T,tint) to D65. */
export function adaptationMatrix(T: number, tint: number, space: RgbSpace = WORKING_SPACE): Mat3 {
  const toXyz = rgbToXyz(space);
  return mul(inv(toXyz), mul(bradford(xyToXYZ(illuminantXY(T, tint)), xyToXYZ(space.white)), toXyz));
}

/**
 * White-balance matrix applied in the shader: the image was rendered assuming
 * (T0, tint0) (as-shot); the user chose (T, tint).
 */
export function wbMatrix(T: number, tint: number, T0: number, tint0: number): Mat3 {
  return mul(adaptationMatrix(T, tint), inv(adaptationMatrix(T0, tint0)));
}

/** Von Kries diagonal gains in working RGB for an illuminant, normalized so G = 1. */
export function wbGains(T: number, tint: number): Vec3 {
  const w = mulVec(inv(rgbToXyz(WORKING_SPACE)), xyToXYZ(illuminantXY(T, tint)));
  return [w[1] / w[0], 1, w[1] / w[2]];
}

/** Find (T,tint) whose von Kries gains best match `gains` (normalized G=1). */
export function solveTempTint(gains: Vec3): { temp: number; tint: number } {
  const target = [Math.log(gains[0] / gains[1]), Math.log(gains[2] / gains[1])];
  const err = (mired: number, tint: number) => {
    const g = wbGains(1e6 / mired, tint);
    return (Math.log(g[0]) - target[0]) ** 2 + (Math.log(g[2]) - target[1]) ** 2;
  };
  let best = { m: 1e6 / 5500, t: 0, e: Infinity };
  for (let m = 40; m <= 600; m += 10) for (let t = -150; t <= 150; t += 10) { const e = err(m, t); if (e < best.e) best = { m, t, e }; }
  let step = 5, tstep = 5;
  for (let it = 0; it < 40; it++) {
    let improved = false;
    for (const [dm, dt] of [[step, 0], [-step, 0], [0, tstep], [0, -tstep]]) {
      const m = Math.min(600, Math.max(40, best.m + dm)), t = Math.min(150, Math.max(-150, best.t + dt));
      const e = err(m, t);
      if (e < best.e) { best = { m, t, e }; improved = true; }
    }
    if (!improved) { step /= 2; tstep /= 2; if (step < 0.05) break; }
  }
  return { temp: Math.round(1e6 / best.m), tint: Math.round(best.t) };
}

/**
 * Given a working-space color sampled from an image currently balanced for (T0,tint0),
 * find the (T,tint) that renders it neutral. Used by the WB eyedropper and auto WB.
 */
export function neutralizeTempTint(rgb: Vec3, T0: number, tint0: number): { temp: number; tint: number } {
  // Undo current adaptation to get scene-relative values, then find the illuminant whose gains neutralize it.
  const scene = mulVec(inv(adaptationMatrix(T0, tint0)), rgb);
  const g: Vec3 = [scene[1] / Math.max(scene[0], 1e-6), 1, scene[1] / Math.max(scene[2], 1e-6)];
  // gains of illuminant (T,t) = w.y / w.rgb; the scene color is the illuminant color → it is neutral when gains(T,t) ≈ g.
  return solveTempTint(g);
}

/** Relative temp slider (non-RAW): -100..100 → Kelvin around 5500K in mireds. */
export const relToKelvin = (rel: number) => 1e6 / (1e6 / 5500 - rel);
export const kelvinToRel = (k: number) => 1e6 / 5500 - 1e6 / k;

/* ------------------------------------------------------------------ OkLab */

export function linearSrgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
export function oklabToLinearSrgb([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
export const oklabToLch = ([L, a, b]: Vec3): Vec3 => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
export const lchToOklab = ([L, C, h]: Vec3): Vec3 => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

/** Hue (degrees, OkLCh) centers of the eight HSL mixer channels. */
export const HSL_CENTERS = [25, 55, 105, 145, 195, 255, 295, 335];

export function hexFromLinearSrgb(rgb: Vec3): string {
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255).toString(16).padStart(2, '0')).join('');
}
