import { describe, it, expect } from 'vitest';
import { defaultEdit, applyPartial, blendEdits, pickGroups, normalizeEdit, isEdited, ALL_GROUPS } from '../../src/shared/edit';
import { parseSearch, looksNatural } from '../../src/shared/nlsearch';
import { targetSize } from '../../src/shared/exportSize';
import { kelvinToRel, relToKelvin, linearSrgbToOklab, oklabToLinearSrgb, wbGains, solveTempTint, convertMatrix, SPACES, mulVec } from '../../src/shared/color';
import { normalizeCombo, DEFAULT_SHORTCUTS } from '../../src/shared/shortcuts';
import { formatFor, isRawFile } from '../../src/shared/formats';
import { BUILTIN_PRESETS } from '../../src/shared/builtinPresets';

describe('edit model', () => {
  it('a default edit is not "edited"', () => {
    expect(isEdited(defaultEdit(true), true)).toBe(false);
  });
  it('applyPartial only touches the given settings and blends by amount', () => {
    const base = defaultEdit(true);
    const half = applyPartial(base, { exposure: 1, contrast: 40 }, 0.5);
    expect(half.exposure).toBeCloseTo(0.5);
    expect(half.contrast).toBeCloseTo(20);
    expect(half.highlights).toBe(base.highlights);
    expect(base.exposure).toBe(0); // input not mutated
  });
  it('blendEdits interpolates numbers and keeps endpoints', () => {
    const a = defaultEdit(true), b = defaultEdit(true);
    b.vibrance = 40; b.grading.shadows = { hue: 200, sat: 30, lum: 0 };
    expect(blendEdits(a, b, 0).vibrance).toBe(0);
    expect(blendEdits(a, b, 1).vibrance).toBe(40);
    expect(blendEdits(a, b, 0.5).vibrance).toBeCloseTo(20);
  });
  it('pickGroups returns exactly the keys of the chosen groups', () => {
    const e = defaultEdit(true);
    expect(Object.keys(pickGroups(e, ['tone'])).sort()).toEqual(['blacks', 'contrast', 'exposure', 'highlights', 'shadows', 'whites']);
    expect(Object.keys(pickGroups(e, ['hsl', 'grading'])).sort()).toEqual(['grading', 'hsl']);
  });
  it('normalizeEdit fills missing fields from older catalogs', () => {
    const n = normalizeEdit({ exposure: 1.2 } as any, false);
    expect(n.exposure).toBe(1.2);
    expect(n.masks).toEqual([]);
    expect(n.curve.rgb.length).toBeGreaterThanOrEqual(2);
  });
});

describe('built-in presets', () => {
  it('have unique ids and only use known groups', () => {
    const ids = new Set(BUILTIN_PRESETS.map(p => p.id));
    expect(ids.size).toBe(BUILTIN_PRESETS.length);
    for (const p of BUILTIN_PRESETS) {
      expect(p.groups.every(g => ALL_GROUPS.includes(g))).toBe(true);
      const applied = applyPartial(defaultEdit(true), p.settings);
      expect(Number.isFinite(applied.exposure)).toBe(true);
    }
  });
});

describe('natural-language search', () => {
  it('understands ratings, focal length and ISO', () => {
    const r = parseSearch('5 star portraits shot at 85mm iso 400');
    const fields = r.rules.map(x => x.field);
    expect(fields).toContain('rating');
    expect(fields).toContain('focalLength');
    expect(fields).toContain('iso');
    expect(looksNatural('5 star portraits shot at 85mm')).toBe(true);
    expect(looksNatural('IMG_0421')).toBe(false);
  });
});

describe('export sizing', () => {
  const base = { mode: 'none', width: 0, height: 0, long: 0, megapixels: 0, noEnlarge: true } as const;
  it('long edge', () => {
    expect(targetSize({ ...base, mode: 'long', long: 2048 }, 6000, 4000)).toEqual({ width: 2048, height: 1365 });
  });
  it('never enlarges unless allowed', () => {
    const t = targetSize({ ...base, mode: 'long', long: 3000 }, 2400, 1600);
    expect(t === null || (t.width <= 2400 && t.height <= 1600)).toBe(true);
  });
});

describe('color science', () => {
  it('relative temperature scale round-trips', () => {
    for (const k of [2500, 4000, 5500, 7500, 12000]) expect(relToKelvin(kelvinToRel(k))).toBeCloseTo(k, 3);
  });
  it('OkLab round-trips', () => {
    const c: [number, number, number] = [0.2, 0.5, 0.8];
    const back = oklabToLinearSrgb(linearSrgbToOklab(c));
    back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 4));
  });
  it('white balance gains invert back to temperature and tint', () => {
    for (const [t, tint] of [[3200, 0], [5500, 10], [7500, -15]]) {
      const s = solveTempTint(wbGains(t, tint));
      expect(Math.abs(s.temp - t) / t).toBeLessThan(0.03);
      expect(Math.abs(s.tint - tint)).toBeLessThan(3);
    }
  });
  it('white stays white across working and output spaces', () => {
    const m = convertMatrix(SPACES.rec2020, SPACES.srgb);
    mulVec(m, [1, 1, 1]).forEach(v => expect(v).toBeCloseTo(1, 3));
  });
});

describe('formats and shortcuts', () => {
  it('recognises RAW formats from every listed vendor', () => {
    for (const ext of ['cr2', 'cr3', 'arw', 'raf', 'nef', 'orf', 'rw2', 'pef', 'dng']) expect(isRawFile(`a.${ext.toUpperCase()}`)).toBe(true);
    for (const ext of ['jpg', 'png', 'tiff', 'webp', 'heic']) expect(formatFor(`a.${ext}`)?.raw).toBe(false);
  });
  it('normalizes key combos the same way the defaults are written', () => {
    const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    expect(normalizeCombo(ev('z', { ctrlKey: true }), false)).toBe(DEFAULT_SHORTCUTS['edit.undo']);
    expect(normalizeCombo(ev('Z', { ctrlKey: true, shiftKey: true }), false)).toBe(DEFAULT_SHORTCUTS['edit.redo']);
    expect(normalizeCombo(ev('z', { metaKey: true }), true)).toBe('Mod+Z');
    expect(normalizeCombo(ev('R', { shiftKey: true }), false)).toBe(DEFAULT_SHORTCUTS['workspace.reference']);
  });
});
