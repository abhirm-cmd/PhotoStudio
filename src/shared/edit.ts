/**
 * The non-destructive edit model.
 *
 * Every adjustment a user makes is stored as data in an `EditParams` document.
 * Originals are never touched; the render engine re-derives pixels from the
 * original + these instructions. The document is versioned so the format can
 * evolve without breaking catalogs.
 */

export const EDIT_VERSION = 1;

export type Vec2 = [number, number];

export interface CurvePoint { x: number; y: number }

export interface ToneCurve {
  /** Parametric region sliders, -100..100 */
  parametric: { highlights: number; lights: number; darks: number; shadows: number; split: [number, number, number] };
  /** Point curves in 0..1 perceptual space. Always include endpoints. */
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export const HSL_CHANNELS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslChannel = (typeof HSL_CHANNELS)[number];
export interface HslValues { hue: number; saturation: number; luminance: number }

export interface GradeWheel { hue: number; sat: number; lum: number }

export interface ColorGrading {
  shadows: GradeWheel;
  midtones: GradeWheel;
  highlights: GradeWheel;
  global: GradeWheel;
  /** 0..100 */
  blending: number;
  /** -100..100 */
  balance: number;
}

export interface CropRect {
  /** Normalized to the transformed (straightened) image, 0..1 */
  x: number; y: number; w: number; h: number;
  /** Straighten angle in degrees, -45..45 */
  angle: number;
  /** Aspect ratio label, e.g. "original", "free", "3:2" */
  aspect: string;
  flipH: boolean;
  flipV: boolean;
  /** 0, 90, 180, 270 */
  orientation: number;
}

export interface Transform {
  vertical: number;   // -100..100 keystone
  horizontal: number; // -100..100 keystone
  rotate: number;     // degrees -10..10
  aspect: number;     // -100..100
  scale: number;      // 50..150 (%)
  offsetX: number;    // -100..100
  offsetY: number;    // -100..100
  upright: 'off' | 'auto' | 'level' | 'vertical' | 'full' | 'guided';
  guides: { a: Vec2; b: Vec2 }[];
}

export interface Optics {
  enableProfile: boolean;
  profileId: string | null;
  removeCA: boolean;
  /** Manual distortion -100..100 */
  distortion: number;
  /** Manual vignetting correction -100..100 and midpoint 0..100 */
  vignetting: number;
  vignettingMidpoint: number;
  /** Defringe amounts 0..20 */
  defringePurple: number;
  defringeGreen: number;
  /** Lateral CA scale corrections, derived by auto-CA or set manually (-100..100). */
  caRed: number;
  caBlue: number;
}

export interface Detail {
  sharpenAmount: number;   // 0..150
  sharpenRadius: number;   // 0.5..3
  sharpenDetail: number;   // 0..100
  sharpenMasking: number;  // 0..100
  noiseReduction: number;  // 0..100
  noiseDetail: number;     // 0..100
  colorNoiseReduction: number; // 0..100
}

export interface Effects {
  texture: number;   // -100..100
  clarity: number;   // -100..100
  dehaze: number;    // -100..100
  vignetteAmount: number;    // -100..100
  vignetteMidpoint: number;  // 0..100
  vignetteRoundness: number; // -100..100
  vignetteFeather: number;   // 0..100
  vignetteHighlights: number;// 0..100
  grainAmount: number;    // 0..100
  grainSize: number;      // 0..100
  grainRoughness: number; // 0..100
}

export interface Calibration {
  shadowTint: number; // -100..100
  redHue: number; redSat: number;
  greenHue: number; greenSat: number;
  blueHue: number; blueSat: number;
}

export interface Portrait {
  skinSmoothing: number;  // 0..100
  skinTone: number;       // -100..100 (warm/cool balance of skin)
  skinEvenness: number;   // 0..100 hue/sat unification of skin
  eyeEnhance: number;     // 0..100
  teethWhitening: number; // 0..100
  faceLight: number;      // 0..100
}

/** Adjustments available inside a mask. All are relative offsets, 0 = neutral. */
export interface LocalAdjustments {
  exposure: number;   // EV -4..4
  contrast: number;   // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temp: number;       // -100..100 relative
  tint: number;       // -100..100 relative
  saturation: number;
  vibrance: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpness: number;  // -100..100
  noise: number;      // 0..100
  hue: number;        // -180..180 degrees hue rotate
  /** Color overlay: hue (deg) and saturation 0..100 */
  colorHue: number;
  colorSat: number;
}

export type MaskOp = 'add' | 'subtract' | 'intersect';

export interface BrushDab { x: number; y: number; r: number; flow: number; feather: number; erase: boolean }

export type MaskComponent =
  | { id: string; type: 'linear'; op: MaskOp; invert: boolean; a: Vec2; b: Vec2 }
  | { id: string; type: 'radial'; op: MaskOp; invert: boolean; cx: number; cy: number; rx: number; ry: number; angle: number; feather: number }
  | { id: string; type: 'brush'; op: MaskOp; invert: boolean; dabs: BrushDab[] }
  | { id: string; type: 'color'; op: MaskOp; invert: boolean; samples: [number, number, number][]; range: number }
  | { id: string; type: 'luminance'; op: MaskOp; invert: boolean; min: number; max: number; feather: number }
  | { id: string; type: 'ai'; op: MaskOp; invert: boolean; target: AiMaskTarget; /** catalog blob key of the mask bitmap */ ref: string; provider: string }
  | { id: string; type: 'all'; op: MaskOp; invert: boolean };

export type AiMaskTarget = 'subject' | 'sky' | 'background' | 'people' | 'face' | 'skin' | 'hair' | 'clothing' | 'eyes' | 'teeth' | 'object';

export interface Mask {
  id: string;
  name: string;
  visible: boolean;
  invert: boolean;
  density: number; // 0..100
  feather: number; // global extra feather 0..100
  refine: number;  // edge refinement 0..100
  components: MaskComponent[];
  adjust: LocalAdjustments;
}

export interface EditParams {
  version: number;
  /** Camera profile id used to render RAW data to display-referred values */
  profile: string;
  /** Scene white balance. temp in Kelvin, tint -150..150. `mode` describes origin. */
  wb: { mode: 'asShot' | 'auto' | 'custom'; temp: number; tint: number };
  exposure: number;   // EV -5..5
  contrast: number;   // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  curve: ToneCurve;
  hsl: Record<HslChannel, HslValues>;
  grading: ColorGrading;
  detail: Detail;
  optics: Optics;
  transform: Transform;
  crop: CropRect;
  effects: Effects;
  calibration: Calibration;
  portrait: Portrait;
  masks: Mask[];
}

export const linearCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }];

export function defaultLocal(): LocalAdjustments {
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temp: 0, tint: 0, saturation: 0, vibrance: 0, texture: 0, clarity: 0, dehaze: 0,
    sharpness: 0, noise: 0, hue: 0, colorHue: 0, colorSat: 0,
  };
}

export const DEFAULT_TEMP = 5500;

export function defaultEdit(isRaw = true): EditParams {
  const hsl = {} as Record<HslChannel, HslValues>;
  for (const c of HSL_CHANNELS) hsl[c] = { hue: 0, saturation: 0, luminance: 0 };
  const wheel = (): GradeWheel => ({ hue: 0, sat: 0, lum: 0 });
  return {
    version: EDIT_VERSION,
    profile: isRaw ? 'photostudio-standard' : 'embedded',
    wb: { mode: 'asShot', temp: DEFAULT_TEMP, tint: 0 },
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    vibrance: 0, saturation: 0,
    curve: {
      parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0, split: [0.25, 0.5, 0.75] },
      rgb: linearCurve(), red: linearCurve(), green: linearCurve(), blue: linearCurve(),
    },
    hsl,
    grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
    detail: {
      sharpenAmount: isRaw ? 40 : 0, sharpenRadius: 1.0, sharpenDetail: 25, sharpenMasking: 0,
      noiseReduction: 0, noiseDetail: 50, colorNoiseReduction: isRaw ? 25 : 0,
    },
    optics: {
      enableProfile: false, profileId: null, removeCA: false, distortion: 0, vignetting: 0, vignettingMidpoint: 50,
      defringePurple: 0, defringeGreen: 0, caRed: 0, caBlue: 0,
    },
    transform: { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0, upright: 'off', guides: [] },
    crop: { x: 0, y: 0, w: 1, h: 1, angle: 0, aspect: 'original', flipH: false, flipV: false, orientation: 0 },
    effects: {
      texture: 0, clarity: 0, dehaze: 0,
      vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0,
      grainAmount: 0, grainSize: 25, grainRoughness: 50,
    },
    calibration: { shadowTint: 0, redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 },
    portrait: { skinSmoothing: 0, skinTone: 0, skinEvenness: 0, eyeEnhance: 0, teethWhitening: 0, faceLight: 0 },
    masks: [],
  };
}

export function cloneEdit<T>(e: T): T {
  return structuredClone(e);
}

/** Migrate / fill missing fields from older or partial documents (e.g. presets). */
export function normalizeEdit(input: Partial<EditParams> | null | undefined, isRaw = true): EditParams {
  const base = defaultEdit(isRaw);
  if (!input) return base;
  return deepMerge(base, input) as EditParams;
}

export function deepMerge(base: any, over: any): any {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : structuredClone(over);
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out: any = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over;
}

/* ---------------------------------------------------------------------------
 * Setting groups — used by presets ("save only Color + Tone Curve"),
 * copy/paste/sync, and history labels.
 * ------------------------------------------------------------------------- */

export const SETTING_GROUPS = {
  whiteBalance: { label: 'White Balance', keys: ['wb'] },
  tone: { label: 'Basic Tone', keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
  presence: { label: 'Presence', keys: ['vibrance', 'saturation'] },
  profile: { label: 'Profile', keys: ['profile'] },
  toneCurve: { label: 'Tone Curve', keys: ['curve'] },
  hsl: { label: 'Color Mixer (HSL)', keys: ['hsl'] },
  grading: { label: 'Color Grading', keys: ['grading'] },
  detail: { label: 'Detail', keys: ['detail'] },
  optics: { label: 'Optics', keys: ['optics'] },
  transform: { label: 'Transform', keys: ['transform'] },
  crop: { label: 'Crop', keys: ['crop'] },
  effects: { label: 'Effects', keys: ['effects'] },
  calibration: { label: 'Calibration', keys: ['calibration'] },
  portrait: { label: 'Portrait', keys: ['portrait'] },
  masks: { label: 'Masks', keys: ['masks'] },
} as const;

export type SettingGroup = keyof typeof SETTING_GROUPS;
export const ALL_GROUPS = Object.keys(SETTING_GROUPS) as SettingGroup[];
/** Groups a preset includes by default (crop/masks/transform are image-specific). */
export const DEFAULT_PRESET_GROUPS: SettingGroup[] = ['whiteBalance', 'tone', 'presence', 'profile', 'toneCurve', 'hsl', 'grading', 'detail', 'effects', 'calibration'];

/** Extract a partial edit containing only the chosen groups. */
export function pickGroups(edit: EditParams, groups: SettingGroup[]): Partial<EditParams> {
  const out: any = {};
  for (const g of groups) for (const k of SETTING_GROUPS[g].keys) out[k] = structuredClone((edit as any)[k]);
  return out;
}

/** Apply a partial edit onto an existing one, optionally scaled by `amount` (0..1) toward neutral. */
export function applyPartial(target: EditParams, partial: Partial<EditParams>, amount = 1, isRaw = true): EditParams {
  const merged = deepMerge(cloneEdit(target), partial) as EditParams;
  if (amount >= 0.999) return merged;
  return blendEdits(target, merged, amount);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Numeric interpolation between two edits (used for preset/grade strength). */
export function blendEdits(a: EditParams, b: EditParams, t: number): EditParams {
  const walk = (x: any, y: any): any => {
    if (typeof x === 'number' && typeof y === 'number') return lerp(x, y, t);
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length && typeof x[0] === 'object' && 'x' in x[0]) return blendCurve(x, y, t);
      if (x.length === y.length) return x.map((v, i) => walk(v, y[i]));
      return t < 0.5 ? structuredClone(x) : structuredClone(y);
    }
    if (x && y && typeof x === 'object') {
      const o: any = {};
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) o[k] = k in x && k in y ? walk(x[k], y[k]) : (k in y ? y[k] : x[k]);
      return o;
    }
    return t < 0.5 ? x : y;
  };
  return walk(a, b);
}

/** Blend two point curves by resampling both on a common grid. */
export function blendCurve(a: CurvePoint[], b: CurvePoint[], t: number): CurvePoint[] {
  if (isIdentityCurve(a) && isIdentityCurve(b)) return linearCurve();
  const xs = Array.from(new Set([...a.map(p => p.x), ...b.map(p => p.x)])).sort((p, q) => p - q);
  return xs.map(x => ({ x, y: lerp(evalLinear(a, x), evalLinear(b, x), t) }));
}

function evalLinear(pts: CurvePoint[], x: number) {
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const p = pts[i - 1], q = pts[i];
      const u = q.x - p.x < 1e-6 ? 0 : (x - p.x) / (q.x - p.x);
      return lerp(p.y, q.y, u);
    }
  }
  return pts[pts.length - 1].y;
}

export function isIdentityCurve(c: CurvePoint[]) {
  return c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
}

/** True if the edit differs from the default for its type — used for "edited" filters. */
export function isEdited(edit: EditParams, isRaw: boolean): boolean {
  return JSON.stringify(stripVolatile(edit)) !== JSON.stringify(stripVolatile(defaultEdit(isRaw)));
}
function stripVolatile(e: EditParams) {
  const c: any = cloneEdit(e);
  c.wb = { ...c.wb, mode: 'asShot' };
  if (e.wb.mode === 'asShot') c.wb.temp = DEFAULT_TEMP, c.wb.tint = 0;
  return c;
}

/**
 * Human-readable description of what changed between two edits.
 * Drives the history panel ("Exposure +0.35", "Crop", "Mask: Sky"...).
 */
export function describeChange(prev: EditParams, next: EditParams): string {
  const changed: string[] = [];
  const scalar = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] as const;
  for (const k of scalar) {
    if (prev[k] !== next[k]) {
      const v = next[k];
      const label = k[0].toUpperCase() + k.slice(1);
      const sign = v > 0 ? '+' : '';
      changed.push(k === 'exposure' ? `${label} ${sign}${v.toFixed(2)}` : `${label} ${sign}${Math.round(v)}`);
    }
  }
  if (JSON.stringify(prev.wb) !== JSON.stringify(next.wb)) changed.push(next.wb.mode === 'auto' ? 'Auto White Balance' : 'White Balance');
  const groups: [keyof EditParams, string][] = [
    ['profile', 'Profile'], ['curve', 'Tone Curve'], ['hsl', 'Color Mixer'], ['grading', 'Color Grading'], ['detail', 'Detail'],
    ['optics', 'Lens Corrections'], ['transform', 'Transform'], ['crop', 'Crop'], ['effects', 'Effects'],
    ['calibration', 'Calibration'], ['portrait', 'Portrait'], ['masks', 'Masking'],
  ];
  for (const [k, label] of groups) if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) changed.push(label);
  if (!changed.length) return 'No change';
  if (changed.length > 3) return `${changed.slice(0, 2).join(', ')} +${changed.length - 2} more`;
  return changed.join(', ');
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
