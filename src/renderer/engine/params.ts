/** Converts an EditParams document into shader uniform values. */
import { HSL_CHANNELS, type EditParams, type LocalAdjustments, type GradeWheel } from '@shared/edit';
import { HSL_CENTERS, wbMatrix, mul, IDENTITY, type Mat3 } from '@shared/color';
import { getProfile } from './profiles';

export const MAX_MASKS = 12;

/** Build the calibration matrix: rotates/scales each primary around the neutral axis, white preserved. */
export function calibrationMatrix(c: EditParams['calibration']): Mat3 {
  const prim = [
    { hue: c.redHue, sat: c.redSat, v: [1, 0, 0] },
    { hue: c.greenHue, sat: c.greenSat, v: [0, 1, 0] },
    { hue: c.blueHue, sat: c.blueSat, v: [0, 0, 1] },
  ];
  if (prim.every(p => !p.hue && !p.sat)) return IDENTITY;
  // Orthonormal basis of the chroma plane (perpendicular to gray axis)
  const e1 = [1 / Math.SQRT2, -1 / Math.SQRT2, 0];
  const e2 = [1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)];
  const cols = prim.map(p => {
    const g = (p.v[0] + p.v[1] + p.v[2]) / 3;
    const ch = p.v.map(x => x - g);
    let a = ch[0] * e1[0] + ch[1] * e1[1] + ch[2] * e1[2];
    let b = ch[0] * e2[0] + ch[1] * e2[1] + ch[2] * e2[2];
    const ang = (p.hue / 100) * (30 * Math.PI / 180);
    const s = 1 + (p.sat / 100) * 0.5;
    [a, b] = [(a * Math.cos(ang) - b * Math.sin(ang)) * s, (a * Math.sin(ang) + b * Math.cos(ang)) * s];
    return [g + a * e1[0] + b * e2[0], g + a * e1[1] + b * e2[1], g + a * e1[2] + b * e2[2]];
  });
  // columns → matrix; normalize rows so white (1,1,1) maps to itself
  const m = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  for (let r = 0; r < 3; r++) { const s = m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]; for (let k = 0; k < 3; k++) m[r * 3 + k] /= s; }
  return m;
}

export function wheelToLab(w: GradeWheel): [number, number, number, number] {
  const mag = (w.sat / 100) * 0.06;
  const h = (w.hue * Math.PI) / 180;
  return [Math.cos(h) * mag, Math.sin(h) * mag, (w.lum / 100) * 0.08, 0];
}

export function packLocal(a: LocalAdjustments): number[] {
  return [
    a.exposure, a.contrast, a.highlights, a.shadows,
    a.whites, a.blacks, a.temp, a.tint,
    a.saturation, a.vibrance, a.texture, a.clarity,
    a.dehaze, a.sharpness, a.noise, a.hue,
    a.colorHue, a.colorSat, 0, 0,
  ];
}

export interface DevelopContext { isRaw: boolean; asShot: { temp: number; tint: number }; outW: number; outH: number; pxScale: number; atmos: number; grainSeed: number }

export function developUniforms(e: EditParams, ctx: DevelopContext): Record<string, any> {
  const prof = getProfile(e.profile, ctx.isRaw);
  const wb = wbMatrix(e.wb.temp, e.wb.tint, ctx.asShot.temp, ctx.asShot.tint);
  const hsl = HSL_CHANNELS.map(c => [e.hsl[c].hue / 100, e.hsl[c].saturation / 100, e.hsl[c].luminance / 100]);
  const masks = e.masks.slice(0, MAX_MASKS);
  const local = new Float32Array(MAX_MASKS * 5 * 4);
  const dens = new Float32Array(MAX_MASKS);
  masks.forEach((m, i) => { if (m.visible) { local.set(packLocal(m.adjust), i * 20); dens[i] = m.density / 100; } });
  return {
    uWB: wb,
    uCalib: calibrationMatrix(e.calibration),
    uShadowTint: e.calibration.shadowTint / 100,
    uProfile: prof.kind === 'display' ? 0 : prof.kind === 'linear' ? 4 : 1,
    uMono: !!prof.mono,
    uBaseline: prof.baseline,
    uProfileParams: [Math.pow(2, prof.baseline), prof.contrast, prof.saturation],
    uExposure: e.exposure,
    uContrast: e.contrast / 100, uHighlights: e.highlights / 100, uShadows: e.shadows / 100, uWhites: e.whites / 100, uBlacks: e.blacks / 100,
    uTexture: e.effects.texture / 100, uClarity: e.effects.clarity / 100, uDehaze: e.effects.dehaze / 100,
    uVibrance: e.vibrance / 100, uSaturation: e.saturation / 100,
    uAtmos: [ctx.atmos, ctx.atmos, ctx.atmos],
    uHsl: hsl.flat(), uHslCenters: HSL_CENTERS,
    uGradeShadows: wheelToLab(e.grading.shadows), uGradeMid: wheelToLab(e.grading.midtones), uGradeHigh: wheelToLab(e.grading.highlights), uGradeGlobal: wheelToLab(e.grading.global),
    uGradeBlend: e.grading.blending / 100, uGradeBalance: e.grading.balance / 100,
    uVignette: [e.effects.vignetteAmount / 100, e.effects.vignetteMidpoint / 100, e.effects.vignetteRoundness / 100, e.effects.vignetteFeather / 100],
    uVignetteHL: e.effects.vignetteHighlights / 100,
    uGrain: [e.effects.grainAmount / 100, e.effects.grainSize / 100, e.effects.grainRoughness / 100],
    uGrainSeed: ctx.grainSeed,
    uPortrait: [e.portrait.skinSmoothing / 100, e.portrait.skinTone / 100, e.portrait.skinEvenness / 100, e.portrait.faceLight / 100],
    uPortrait2: [e.portrait.eyeEnhance / 100, e.portrait.teethWhitening / 100],
    uDefringe: [e.optics.defringePurple / 20, e.optics.defringeGreen / 20],
    uOutSize: [ctx.outW, ctx.outH],
    uPxScale: ctx.pxScale,
    uMaskCount: masks.length,
    uMaskDensity: dens,
    uLocal: local,
  };
}

/** Per-mask scalar for one local parameter (used by NR and sharpen passes). */
export function maskParamArray(e: EditParams, key: keyof LocalAdjustments) {
  const a = new Float32Array(MAX_MASKS), d = new Float32Array(MAX_MASKS);
  e.masks.slice(0, MAX_MASKS).forEach((m, i) => { if (m.visible) { a[i] = m.adjust[key]; d[i] = m.density / 100; } });
  return { uMaskParam: a, uMaskDensity: d, uMaskCount: Math.min(e.masks.length, MAX_MASKS) };
}

export { mul };
