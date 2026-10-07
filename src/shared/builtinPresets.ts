/**
 * Built-in presets. Each is a real set of develop settings, built by overriding
 * the neutral defaults and storing the complete values of every group it touches,
 * so applying preset B after preset A fully replaces A (no leftover settings).
 * Exposure is image-specific and is only stored when a preset deliberately sets it.
 */
import { defaultEdit, deepMerge, pickGroups, type EditParams, type SettingGroup, type CurvePoint } from './edit';
import type { Preset } from './types';

type Over = { [K in keyof EditParams]?: any };

const STYLE_GROUPS: SettingGroup[] = ['tone', 'presence', 'toneCurve', 'hsl', 'grading', 'effects', 'calibration'];

const pts = (...xy: number[]): CurvePoint[] => { const o: CurvePoint[] = []; for (let i = 0; i < xy.length; i += 2) o.push({ x: xy[i], y: xy[i + 1] }); return o; };
const wheel = (hue: number, sat: number, lum = 0) => ({ hue, sat, lum });
const hsl = (o: Record<string, [number, number, number]>) => Object.fromEntries(Object.entries(o).map(([k, [hue, saturation, luminance]]) => [k, { hue, saturation, luminance }]));

function preset(folder: string, name: string, over: Over, opts: { groups?: SettingGroup[]; note?: string; kind?: 'builtin' | 'ai' } = {}): Preset {
  const full = deepMerge(defaultEdit(true), over) as EditParams;
  const groups = opts.groups ?? STYLE_GROUPS;
  const settings = pickGroups(full, groups);
  if (!('exposure' in over)) delete (settings as any).exposure;
  const id = 'builtin-' + (folder + '-' + name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { id, name, folder, favorite: false, builtin: true, groups, settings, createdAt: '2026-01-01T00:00:00.000Z', source: { kind: opts.kind ?? 'builtin', note: opts.note } };
}

export const BUILTIN_PRESETS: Preset[] = [
  /* ------------------------------------------------------------- Wedding */
  preset('Wedding', 'Clean & Bright', {
    contrast: -8, highlights: -30, shadows: 25, whites: 12, blacks: -4, vibrance: 10, saturation: -4,
    curve: { rgb: pts(0, 0.03, 0.25, 0.27, 0.75, 0.78, 1, 1) },
    hsl: hsl({ orange: [0, -6, 6], yellow: [-4, -12, 4], green: [10, -20, 0], blue: [-4, -10, 0] }),
    grading: { highlights: wheel(50, 6), shadows: wheel(220, 4) },
    effects: { clarity: -4, texture: -4 },
  }, { note: 'Airy skin, soft greens, clean whites' }),
  preset('Wedding', 'Soft Romantic', {
    contrast: -18, highlights: -40, shadows: 30, whites: 6, blacks: 10, vibrance: 6, saturation: -10,
    curve: { rgb: pts(0, 0.08, 0.3, 0.33, 0.72, 0.74, 1, 0.97) },
    hsl: hsl({ red: [4, -4, 4], orange: [2, -8, 8], green: [16, -35, 4], aqua: [0, -20, 0] }),
    grading: { highlights: wheel(35, 10), midtones: wheel(20, 4), shadows: wheel(300, 4), blending: 70 },
    effects: { clarity: -12, texture: -8, vignetteAmount: -10 },
  }, { note: 'Faded blacks, rosy highlights' }),
  preset('Wedding', 'Classic Film', {
    contrast: 10, highlights: -25, shadows: 15, whites: -6, blacks: 6, vibrance: 4, saturation: -6,
    curve: { rgb: pts(0, 0.05, 0.22, 0.2, 0.5, 0.52, 0.8, 0.84, 1, 0.96) },
    hsl: hsl({ orange: [-2, -4, 4], yellow: [-8, -15, 0], green: [14, -30, -6], blue: [-8, -15, -6] }),
    grading: { highlights: wheel(45, 12), shadows: wheel(195, 10), balance: -10 },
    effects: { grainAmount: 14, grainSize: 22 },
  }, { note: 'Warm highlights, teal shadows, fine grain' }),
  preset('Wedding', 'Timeless B&W', {
    contrast: 18, highlights: -20, shadows: 15, whites: 10, blacks: -12, saturation: -100,
    hsl: hsl({ red: [0, 0, 8], orange: [0, 0, 12], blue: [0, 0, -14] }),
    curve: { rgb: pts(0, 0.02, 0.25, 0.22, 0.75, 0.8, 1, 1) },
    effects: { clarity: 8, grainAmount: 10, grainSize: 20, vignetteAmount: -14 },
  }, { note: 'Luminous skin, rich blacks' }),

  /* ------------------------------------------------------------- Outdoor */
  preset('Outdoor', 'Vivid Landscape', {
    contrast: 16, highlights: -45, shadows: 30, whites: 14, blacks: -12, vibrance: 28, saturation: 4,
    hsl: hsl({ yellow: [-6, 10, 0], green: [-8, 8, -6], aqua: [0, 12, -6], blue: [-4, 14, -12] }),
    effects: { clarity: 16, texture: 14, dehaze: 10 },
  }, { note: 'Punchy colour and depth' }),
  preset('Outdoor', 'Moody Forest', {
    contrast: 12, highlights: -35, shadows: 10, whites: -10, blacks: -6, vibrance: -6, saturation: -10,
    curve: { rgb: pts(0, 0.06, 0.3, 0.26, 0.7, 0.72, 1, 0.94) },
    hsl: hsl({ yellow: [-14, -20, -8], green: [18, -30, -18], aqua: [10, -20, -10], orange: [-4, -6, 0] }),
    grading: { shadows: wheel(170, 14, -4), highlights: wheel(40, 8) },
    effects: { clarity: 10, dehaze: 6, vignetteAmount: -18 },
  }, { note: 'Deep, desaturated greens' }),
  preset('Outdoor', 'Crisp Alpine', {
    contrast: 10, highlights: -30, shadows: 20, whites: 18, blacks: -8, vibrance: 18,
    hsl: hsl({ blue: [-6, 16, -16], aqua: [-10, 10, -6], green: [0, -10, 0] }),
    grading: { shadows: wheel(220, 8), highlights: wheel(200, 4) },
    effects: { clarity: 14, texture: 18, dehaze: 18 },
  }, { note: 'Cool clarity for mountains and snow' }),
  preset('Outdoor', 'Matte Travel', {
    contrast: -6, highlights: -25, shadows: 18, blacks: 14, vibrance: 8, saturation: -8,
    curve: { rgb: pts(0, 0.1, 0.25, 0.28, 0.75, 0.76, 1, 0.95) },
    grading: { midtones: wheel(30, 5), shadows: wheel(210, 8) },
    effects: { clarity: 6, grainAmount: 8 },
  }, { note: 'Lifted blacks, travel-magazine feel' }),

  /* -------------------------------------------------------------- Sunset */
  preset('Sunset', 'Warm Glow', {
    contrast: 8, highlights: -50, shadows: 18, whites: -4, vibrance: 22, saturation: 4,
    hsl: hsl({ red: [6, 8, 0], orange: [4, 14, 4], yellow: [-8, 10, 6], purple: [-10, 10, 0], blue: [-14, 0, -10] }),
    grading: { highlights: wheel(38, 18), shadows: wheel(270, 8), blending: 60 },
    effects: { dehaze: 8, vignetteAmount: -12 },
  }, { note: 'Golden sky, purple shadows' }),
  preset('Sunset', 'Fire Sky', {
    contrast: 18, highlights: -60, shadows: 10, whites: 6, blacks: -10, vibrance: 34, saturation: 8,
    hsl: hsl({ red: [8, 18, -4], orange: [6, 22, 0], yellow: [-10, 12, 4], magenta: [0, 14, 0] }),
    grading: { highlights: wheel(22, 20), midtones: wheel(15, 6), shadows: wheel(250, 10) },
    effects: { clarity: 10, dehaze: 14 },
  }, { note: 'Saturated, dramatic skies' }),
  preset('Sunset', 'Dusk Pastel', {
    contrast: -10, highlights: -40, shadows: 22, blacks: 10, vibrance: 10, saturation: -10,
    curve: { rgb: pts(0, 0.08, 0.5, 0.52, 1, 0.96) },
    grading: { highlights: wheel(330, 10), shadows: wheel(240, 10), blending: 80 },
    effects: { clarity: -6 },
  }, { note: 'Soft pinks and blues' }),

  /* --------------------------------------------------------- Golden Hour */
  preset('Golden Hour', 'Honey', {
    contrast: 6, highlights: -35, shadows: 20, vibrance: 16,
    hsl: hsl({ orange: [-2, 6, 6], yellow: [-12, 8, 4], green: [-20, -14, 0] }),
    grading: { highlights: wheel(45, 16), midtones: wheel(38, 6), shadows: wheel(25, 4) },
    effects: { clarity: -4, vignetteAmount: -10 },
  }, { note: 'Rich amber light' }),
  preset('Golden Hour', 'Backlit Haze', {
    contrast: -12, highlights: -20, shadows: 26, blacks: 12, vibrance: 6, saturation: -4,
    curve: { rgb: pts(0, 0.1, 0.4, 0.42, 1, 0.97) },
    grading: { highlights: wheel(48, 20), shadows: wheel(30, 6), blending: 80 },
    effects: { dehaze: -12, clarity: -10 },
  }, { note: 'Dreamy sun flare look' }),
  preset('Golden Hour', 'Warm Contrast', {
    contrast: 20, highlights: -45, shadows: 10, whites: 10, blacks: -14, vibrance: 18,
    grading: { highlights: wheel(40, 14), shadows: wheel(210, 6) },
    effects: { clarity: 12, texture: 8 },
  }, { note: 'Golden tones with punch' }),

  /* -------------------------------------------------------------- Couple */
  preset('Couple', 'Intimate Warm', {
    contrast: 4, highlights: -30, shadows: 18, blacks: 6, vibrance: 8, saturation: -4,
    hsl: hsl({ orange: [2, -4, 6], red: [0, -6, 2], green: [12, -24, 0] }),
    grading: { highlights: wheel(40, 10), midtones: wheel(25, 4), shadows: wheel(10, 4) },
    effects: { clarity: -8, vignetteAmount: -16, vignetteFeather: 70 },
  }, { note: 'Warm and close' }),
  preset('Couple', 'Editorial Muted', {
    contrast: 10, highlights: -30, shadows: 10, whites: -8, blacks: 4, vibrance: -10, saturation: -14,
    curve: { rgb: pts(0, 0.05, 0.25, 0.23, 0.75, 0.77, 1, 0.95) },
    grading: { shadows: wheel(200, 6), highlights: wheel(45, 6) },
    effects: { clarity: 4, grainAmount: 12 },
  }, { note: 'Quiet tones, fashion-magazine contrast' }),
  preset('Couple', 'Cinematic Teal & Orange', {
    contrast: 14, highlights: -40, shadows: 14, whites: 4, blacks: -6, vibrance: 10,
    hsl: hsl({ orange: [-4, 10, 4], aqua: [-14, 12, -8], blue: [-24, 10, -10], green: [-30, -20, -10] }),
    grading: { highlights: wheel(35, 14), shadows: wheel(190, 22), balance: -6, blending: 60 },
    effects: { vignetteAmount: -10 },
  }, { note: 'Film-poster colour contrast' }),

  /* -------------------------------------------------------------- Pastel */
  preset('Pastel', 'Cotton Candy', {
    contrast: -20, highlights: -20, shadows: 30, whites: 10, blacks: 18, vibrance: -8, saturation: -14,
    curve: { rgb: pts(0, 0.12, 0.5, 0.55, 1, 0.98) },
    hsl: hsl({ red: [10, -10, 10], orange: [0, -10, 10], blue: [-8, -16, 12], magenta: [0, 0, 8] }),
    grading: { highlights: wheel(340, 10), shadows: wheel(200, 10), blending: 80 },
    effects: { clarity: -10 },
  }, { note: 'Light, soft, airy colour' }),
  preset('Pastel', 'Mint Fade', {
    contrast: -16, highlights: -18, shadows: 24, blacks: 16, saturation: -18,
    curve: { rgb: pts(0, 0.1, 0.5, 0.53, 1, 0.97), green: pts(0, 0.03, 1, 1) },
    hsl: hsl({ green: [20, -20, 12], aqua: [0, -10, 10], yellow: [-10, -20, 8] }),
    grading: { shadows: wheel(160, 10), highlights: wheel(60, 4) },
  }, { note: 'Fresh, faded mint tones' }),
  preset('Pastel', 'Peach', {
    contrast: -12, highlights: -26, shadows: 22, blacks: 12, vibrance: 6, saturation: -8,
    hsl: hsl({ orange: [-4, -6, 10], red: [6, -10, 8], yellow: [-10, -14, 8] }),
    grading: { highlights: wheel(30, 14), midtones: wheel(20, 6), shadows: wheel(10, 6), blending: 70 },
  }, { note: 'Warm pastel skin and light' }),

  /* ------------------------------------------------------------ Portrait */
  preset('Portrait', 'Natural Skin', {
    contrast: 6, highlights: -24, shadows: 16, vibrance: 6, saturation: -2,
    hsl: hsl({ red: [2, -6, 4], orange: [0, -8, 8], yellow: [-4, -8, 0] }),
    effects: { clarity: -6, texture: -10 },
  }, { note: 'Even, true-to-life skin' }),
  preset('Portrait', 'Studio Pop', {
    contrast: 18, highlights: -20, shadows: 10, whites: 14, blacks: -16, vibrance: 12,
    hsl: hsl({ orange: [0, -4, 6] }),
    effects: { clarity: 6, texture: 4, vignetteAmount: -14 },
  }, { note: 'Bold contrast for studio light' }),

  /* ---------------------------------------------------------- B&W & Film */
  preset('Black & White', 'High Contrast', {
    contrast: 40, highlights: -10, shadows: -6, whites: 22, blacks: -26, saturation: -100,
    hsl: hsl({ blue: [0, 0, -30], aqua: [0, 0, -20], orange: [0, 0, 10] }),
    effects: { clarity: 22, texture: 12 },
  }),
  preset('Black & White', 'Soft Silver', {
    contrast: -10, highlights: -30, shadows: 30, blacks: 12, saturation: -100,
    curve: { rgb: pts(0, 0.07, 0.5, 0.5, 1, 0.96) },
    grading: { global: wheel(220, 4) },
    effects: { grainAmount: 18, grainSize: 30 },
  }),
  preset('Black & White', 'Sepia', {
    contrast: 10, highlights: -20, shadows: 10, saturation: -100,
    grading: { highlights: wheel(40, 22), midtones: wheel(35, 18), shadows: wheel(30, 14) },
    effects: { vignetteAmount: -20, grainAmount: 12 },
  }),
  preset('Film', 'Portra Style', {
    contrast: -4, highlights: -30, shadows: 20, blacks: 8, vibrance: 6, saturation: -6,
    curve: { rgb: pts(0, 0.06, 0.25, 0.26, 0.75, 0.77, 1, 0.96) },
    hsl: hsl({ orange: [-2, -2, 6], yellow: [-6, -10, 0], green: [16, -24, 0], blue: [-6, -12, 0] }),
    grading: { highlights: wheel(45, 8), shadows: wheel(180, 6) },
    effects: { grainAmount: 16, grainSize: 24 },
  }, { note: 'Warm, gentle negative film character' }),
  preset('Film', 'Chrome Slide', {
    contrast: 22, highlights: -20, shadows: -4, whites: 8, blacks: -14, vibrance: 20, saturation: 6,
    hsl: hsl({ red: [4, 10, -4], blue: [-6, 14, -10], green: [-6, 6, -8] }),
    grading: { shadows: wheel(230, 8) },
    effects: { grainAmount: 10, vignetteAmount: -8 },
  }, { note: 'Saturated slide-film colour' }),

  /* --------------------------------------------------------- AI Enhanced */
  preset('AI Enhanced', 'Balanced Base', {
    contrast: 8, highlights: -28, shadows: 22, whites: 8, blacks: -6, vibrance: 14,
    effects: { clarity: 6, texture: 4, dehaze: 4 },
  }, { kind: 'ai', note: 'A neutral starting point. For a per-photo result use AI Auto Enhance, which measures each image.' }),
  preset('AI Enhanced', 'Low Light Rescue', {
    exposure: 0.6, contrast: 4, highlights: -20, shadows: 40, blacks: 8, vibrance: 8, saturation: -6,
    detail: { noiseReduction: 30, colorNoiseReduction: 40, sharpenAmount: 30 },
    effects: { clarity: 4 },
  }, { kind: 'ai', groups: [...STYLE_GROUPS, 'detail'], note: 'Lifts dark scenes and reduces noise' }),
  preset('AI Enhanced', 'Haze Cut', {
    contrast: 10, highlights: -20, shadows: 10, vibrance: 14,
    effects: { dehaze: 28, clarity: 10 },
  }, { kind: 'ai', note: 'Clears atmospheric haze' }),
];
