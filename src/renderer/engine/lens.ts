/**
 * Lens profile system. Profiles hold calibration data per focal length (and aperture
 * for vignetting) in Lensfun conventions; they can be imported from Lensfun XML
 * databases and are converted to the engine's half-diagonal normalization.
 */
import type { EditParams } from '@shared/edit';
import type { LensProfile } from '@shared/types';

export interface LensCorrection { a: number; b: number; c: number; d: number; vig: [number, number, number]; caR: number; caB: number }

const IDENT: LensCorrection = { a: 0, b: 0, c: 0, d: 1, vig: [0, 0, 0], caR: 1, caB: 1 };

/** Generic, clearly labeled starting points. Real calibration data comes from imported Lensfun databases. */
export const GENERIC_PROFILES: LensProfile[] = [
  { id: 'generic-wide', make: 'Generic', model: 'Wide-angle lens (barrel distortion)', distortion: [{ focal: 0, a: 0, b: -0.035, c: 0 }], vignetting: [{ focal: 0, aperture: 0, k1: -0.35, k2: 0.05, k3: 0 }], tca: [{ focal: 0, vr: 1.0003, vb: 0.9997 }], source: 'generic' },
  { id: 'generic-standard', make: 'Generic', model: 'Standard zoom (mild barrel)', distortion: [{ focal: 0, a: 0, b: -0.012, c: 0 }], vignetting: [{ focal: 0, aperture: 0, k1: -0.2, k2: 0.02, k3: 0 }], tca: [{ focal: 0, vr: 1.0001, vb: 0.9999 }], source: 'generic' },
  { id: 'generic-tele', make: 'Generic', model: 'Telephoto (mild pincushion)', distortion: [{ focal: 0, a: 0, b: 0.01, c: 0 }], vignetting: [{ focal: 0, aperture: 0, k1: -0.12, k2: 0, k3: 0 }], tca: [{ focal: 0, vr: 1, vb: 1 }], source: 'generic' },
];

const userProfiles: LensProfile[] = [];
export function registerProfiles(list: LensProfile[]) { for (const p of list) { const i = userProfiles.findIndex(q => q.id === p.id); if (i >= 0) userProfiles[i] = p; else userProfiles.push(p); } }
export function allProfiles(): LensProfile[] { return [...userProfiles, ...GENERIC_PROFILES]; }
export function findProfile(id: string | null): LensProfile | undefined { return id ? allProfiles().find(p => p.id === id) : undefined; }

/** Best match for EXIF lens string. */
export function matchProfile(lensModel?: string, make?: string): LensProfile | undefined {
  if (!lensModel) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const target = norm(lensModel);
  let best: LensProfile | undefined, score = 0;
  for (const p of userProfiles) {
    const m = norm(p.model);
    let s = 0;
    if (m === target) s = 100;
    else if (target.includes(m) || m.includes(target)) s = 50 + Math.min(m.length, target.length);
    if (make && p.make && norm(p.make) === norm(make)) s += 5;
    if (s > score) { score = s; best = p; }
  }
  return score >= 50 ? best : undefined;
}

function interp<T extends { focal: number }>(rows: T[], focal: number, keys: (keyof T)[]): Record<string, number> | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.focal - b.focal);
  if (sorted.length === 1 || !focal) return Object.fromEntries(keys.map(k => [k, Number(sorted[0][k])]));
  let lo = sorted[0], hi = sorted[sorted.length - 1];
  for (const r of sorted) { if (r.focal <= focal) lo = r; if (r.focal >= focal) { hi = r; break; } }
  const t = hi.focal === lo.focal ? 0 : (focal - lo.focal) / (hi.focal - lo.focal);
  return Object.fromEntries(keys.map(k => [k, Number(lo[k]) + (Number(hi[k]) - Number(lo[k])) * t]));
}

/**
 * Combine profile + manual sliders into engine coefficients.
 * `frameW/H` define the conversion from Lensfun's (half short side) normalization.
 */
export function lensCorrection(optics: EditParams['optics'], profile: LensProfile | undefined, focal: number | undefined, aperture: number | undefined, frameW: number, frameH: number): LensCorrection | null {
  const s = Math.hypot(frameW, frameH) / Math.min(frameW, frameH); // r_lf = s * r_ours
  const out: LensCorrection = { ...IDENT, vig: [0, 0, 0] };
  let any = false;
  if (optics.enableProfile && profile) {
    const d = interp(profile.distortion, focal ?? 0, ['a', 'b', 'c']);
    if (d) {
      out.a = d.a * s ** 3; out.b = d.b * s ** 2; out.c = d.c * s; out.d = 1 - d.a - d.b - d.c;
      any = true;
    }
    const minDist = aperture ? Math.min(...profile.vignetting.map(x => Math.abs(x.aperture - aperture))) : 0;
    const vrows = aperture ? profile.vignetting.filter(x => Math.abs(x.aperture - aperture) <= minDist + 1e-6) : profile.vignetting;
    const v = interp(vrows.length ? vrows : profile.vignetting, focal ?? 0, ['k1', 'k2', 'k3']);
    if (v) { out.vig = [v.k1 * s ** 2, v.k2 * s ** 4, v.k3 * s ** 6]; any = true; }
    if (optics.removeCA) {
      const t = interp(profile.tca, focal ?? 0, ['vr', 'vb']);
      if (t) { out.caR = t.vr; out.caB = t.vb; any = true; }
    }
  }
  if (optics.distortion) { out.b += -(optics.distortion / 100) * 0.18; any = true; }
  if (optics.caRed || optics.caBlue) { out.caR *= 1 + (optics.caRed / 100) * 0.004; out.caB *= 1 + (optics.caBlue / 100) * 0.004; any = true; }
  return any || optics.vignetting ? out : null;
}

/** Parse a Lensfun XML database into profiles. */
export function parseLensfunXml(xml: string, sourceName: string): LensProfile[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: LensProfile[] = [];
  doc.querySelectorAll('lens').forEach((lens, i) => {
    const text = (sel: string) => {
      const els = Array.from(lens.querySelectorAll(sel));
      return (els.find(e => !e.getAttribute('lang')) ?? els[0])?.textContent?.trim() ?? '';
    };
    const model = text('model');
    if (!model) return;
    const num = (e: Element, a: string) => Number(e.getAttribute(a) ?? 0);
    const distortion = Array.from(lens.querySelectorAll('calibration distortion')).filter(e => ['ptlens', 'poly3'].includes(e.getAttribute('model') ?? ''))
      .map(e => e.getAttribute('model') === 'poly3' ? { focal: num(e, 'focal'), a: 0, b: num(e, 'k1'), c: 0 } : { focal: num(e, 'focal'), a: num(e, 'a'), b: num(e, 'b'), c: num(e, 'c') });
    const vignetting = Array.from(lens.querySelectorAll('calibration vignetting')).filter(e => e.getAttribute('model') === 'pa')
      .map(e => ({ focal: num(e, 'focal'), aperture: num(e, 'aperture'), k1: num(e, 'k1'), k2: num(e, 'k2'), k3: num(e, 'k3') }));
    const tca = Array.from(lens.querySelectorAll('calibration tca')).filter(e => ['linear', 'poly3'].includes(e.getAttribute('model') ?? ''))
      .map(e => ({ focal: num(e, 'focal'), vr: Number(e.getAttribute('vr') ?? e.getAttribute('kr') ?? 1) || 1, vb: Number(e.getAttribute('vb') ?? e.getAttribute('kb') ?? 1) || 1 }));
    if (!distortion.length && !vignetting.length && !tca.length) return;
    out.push({ id: `lf:${sourceName}:${i}:${model}`, make: text('maker'), model, mount: text('mount'), distortion, vignetting, tca, source: `Lensfun (${sourceName})` });
  });
  return out;
}
