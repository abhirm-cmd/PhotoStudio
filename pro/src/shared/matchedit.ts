/**
 * Match Edit: analyse an already edited reference video and rebuild the same
 * edit (cut points, shot lengths, dissolves, dips and fades, zoom/pan moves
 * and overall look) with new footage.
 *
 * Everything here is pure and runs on small decoded frames, so the same code
 * is used by the main process (analysis) and the renderer (planning).
 */
import { defaultGrade, gradeFn, type Grade } from './grade';
import { clipsOnTrack, mediaOf, newClip, uid, type Clip, type MediaItem, type MotionRect, type Project } from './project';

/* ------------------------------------------------------------------ types */

export interface RefMotion {
  /** The shot's last frame shows this window of its first frame (center and size in fractions; size > 1 = zoomed out) */
  cx: number; cy: number; size: number;
}

export interface RefShot {
  /** Seconds in the reference */
  start: number;
  end: number;
  /** How the shot enters: a dissolve starting at `start`, or a dip to black centred on `start` */
  transitionIn: { type: 'dissolve' | 'dip'; duration: number } | null;
  /** Fade from / to black at the very start / end of the reference (seconds) */
  fadeIn: number;
  fadeOut: number;
  motion: RefMotion | null;
}

export interface RefAnalysis {
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  shots: RefShot[];
  /** RGB samples (0..1, triplets) from the middle of each shot, for look matching */
  colors: number[];
}

/* ------------------------------------------------------- frame analysis */

/** One decoded analysis frame: grayscale plus a tiny RGB thumbnail. */
export interface AFrame { gray: Uint8Array; rgb: Uint8Array }

export const ANALYSIS_COLOR = { w: 16, h: 9 };

/** Size of analysis frames for a source aspect ratio (about 9,000 pixels, even dimensions). */
export function analysisSize(width: number, height: number, area = 9216): { w: number; h: number } {
  const a = width > 0 && height > 0 ? width / height : 16 / 9;
  const w = Math.max(16, Math.round(Math.sqrt(area * a) / 2) * 2);
  return { w, h: Math.max(16, Math.round(w / a / 2) * 2) };
}

const meanAbsDiff = (a: Uint8Array, b: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255; };
const meanOf = (a: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length / 255; };
function hist(a: Uint8Array, bins = 16): Float32Array { const h = new Float32Array(bins); for (let i = 0; i < a.length; i++) h[(a[i] * bins) >> 8]++; for (let i = 0; i < bins; i++) h[i] /= a.length; return h; }
const histDiff = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / 2; };
function median(v: number[]): number { if (!v.length) return 0; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

const BLACK = 0.045;

/**
 * Detect the edit structure of a reference from its analysis frames.
 * Returns shot boundaries in frames plus transitions, fades and motion.
 */
export function analyzeFrames(frames: AFrame[], size: { w: number; h: number }, fps: number, opts: { width?: number; height?: number; hasAudio?: boolean } = {}): RefAnalysis {
  const n = frames.length;
  const luma = frames.map(f => meanOf(f.gray));
  const hists = frames.map(f => hist(f.gray));
  const d = new Array<number>(n).fill(0), hd = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) { d[i] = meanAbsDiff(frames[i].gray, frames[i - 1].gray); hd[i] = histDiff(hists[i], hists[i - 1]); }

  const isBlack = luma.map(l => l < BLACK);
  // boundary frame → transition that enters the shot starting there
  const bounds = new Map<number, RefShot['transitionIn']>();

  /* ---- hard cuts: a single-frame spike well above the local motion level */
  for (let i = 1; i < n; i++) {
    if (isBlack[i] || isBlack[i - 1]) continue;
    const local: number[] = [];
    for (let k = Math.max(1, i - 8); k <= Math.min(n - 1, i + 8); k++) if (Math.abs(k - i) > 1) local.push(d[k]);
    const base = median(local);
    if (d[i] > 0.05 && d[i] > 3 * base + 0.025 && (hd[i] > 0.12 || d[i] > 0.12)) bounds.set(i, null);
  }
  // Two "cuts" right next to each other are one cut (a flash or a dropped frame)
  for (const b of [...bounds.keys()]) if (bounds.has(b - 1)) bounds.delete(b);

  /* ---- dips to black and fades at the ends */
  let fadeIn = 0, fadeOut = 0;
  const dipRanges: [number, number][] = [];
  for (let i = 0; i < n;) {
    if (!isBlack[i]) { i++; continue; }
    let j = i; while (j < n && isBlack[j]) j++;
    // grow over the ramps on both sides (luma falling into the black, rising out of it)
    let a = i; while (a > 0 && i - a < 2 * fps && luma[a - 1] > luma[a] + 0.002 && !bounds.has(a)) a--;
    let b = j; while (b < n && b - j < 2 * fps && b > 0 && luma[b] > luma[b - 1] + 0.002 && !bounds.has(b + 1)) b++;
    if (i === 0) fadeIn = b;                       // black (and ramp up) at the very start
    else if (j >= n) fadeOut = n - a;              // ramp down to black at the very end
    else {
      const mid = Math.round((i + j - 1) / 2);
      for (let k = a; k <= b; k++) bounds.delete(k);
      bounds.set(mid, { type: 'dip', duration: (b - a) / fps });
      dipRanges.push([a, b]);
    }
    i = j;
  }

  // frames inside fades and dips are never part of a dissolve
  const blocked = isBlack.slice();
  for (let t = 0; t < Math.min(n, fadeIn + 1); t++) blocked[t] = true;
  for (let t = Math.max(0, n - fadeOut - 1); t < n; t++) blocked[t] = true;
  for (const r of dipRanges) for (let t = Math.max(0, r[0] - 1); t <= Math.min(n - 1, r[1] + 1); t++) blocked[t] = true;

  /* ---- dissolves: frames that are a straight blend of the frames on either side.
     For a linear dissolve F(c-k) + F(c+k) = 2F(c) while F(c+k) and F(c-k) differ a lot;
     motion, pans and zooms don't have that property. */
  const cuts = new Set(bounds.keys());
  const STRIDE = 3;
  const blend = (c: number, k: number) => {
    const A = frames[c - k].gray, B = frames[c + k].gray, M = frames[c].gray;
    let num = 0, den = 0, cnt = 0;
    for (let i = 0; i < M.length; i += STRIDE) { num += Math.abs(A[i] + B[i] - 2 * M[i]); den += Math.abs(B[i] - A[i]); cnt++; }
    return { ratio: den ? num / den : Infinity, den: den / cnt / 255 };
  };
  const clean = (lo: number, hi: number) => { for (let t = lo; t <= hi; t++) if (blocked[t] || (t > lo && cuts.has(t))) return false; return true; };
  const KS = [3, 5, 8, 12, 17, 24].filter(k => k < 1.5 * fps);
  const cands: { c: number; k: number; ratio: number }[] = [];
  for (let c = 1; c < n - 1; c++) {
    let best: { c: number; k: number; ratio: number } | null = null;
    for (const k of KS) {
      if (c - k < 0 || c + k >= n || !clean(c - k, c + k)) break;
      const r = blend(c, k);
      if (r.den > 0.07 && r.ratio < 0.4 && (!best || k > best.k)) best = { c, k, ratio: r.ratio };
    }
    if (best) cands.push(best);
  }
  // one dissolve per run of neighbouring centres: take the best-fitting centre
  for (let i = 0; i < cands.length;) {
    let j = i; while (j + 1 < cands.length && cands[j + 1].c - cands[j].c <= 2) j++;
    const run = cands.slice(i, j + 1);
    const cen = run.reduce((x, y) => (y.ratio < x.ratio ? y : x));
    i = j + 1;
    // extent: how far each frame is from end A towards end B, fitted with a straight ramp.
    // The ends must sit outside the dissolve, so widen the window until the ramp fits inside it.
    const c = cen.c;
    let maxK = cen.k; while (c - maxK - 1 >= 0 && c + maxK + 1 < n && maxK < 2 * fps && clean(c - maxK - 1, c + maxK + 1)) maxK++;
    const fit = (K: number) => {
      const A = frames[c - K].gray, B = frames[c + K].gray;
      let den = 0; for (let p = 0; p < A.length; p += STRIDE) den += (A[p] - B[p]) ** 2;
      const alpha = (t: number) => { const F = frames[t].gray; let s2 = 0; for (let p = 0; p < F.length; p += STRIDE) s2 += (F[p] - B[p]) * (A[p] - B[p]); return s2 / den; };
      const pts: [number, number][] = [];
      for (let t = c - K; t <= c + K; t++) { const al = alpha(t); if (al > 0.08 && al < 0.92) pts.push([t, al]); }
      if (pts.length < 2) return null;
      const mx = pts.reduce((q, r) => q + r[0], 0) / pts.length, my = pts.reduce((q, r) => q + r[1], 0) / pts.length;
      let sxy = 0, sxx = 0; for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
      const slope = sxy / sxx;
      // α = 1 on the last frame before the dissolve and 0 where it completes
      return slope < 0 ? { start: Math.round(mx + (1 - my) / slope), end: Math.round(mx - my / slope) } : null;
    };
    let K = cen.k, r = fit(K);
    for (let it = 0; r && it < 3; it++) {
      const need = Math.min(maxK, Math.max(c - r.start, r.end - c) + 3);
      if (need <= K) break;
      K = need; r = fit(K);
    }
    if (!r) continue;
    const start = r.start, len = r.end - r.start;
    if (len < 3 || [...cuts].some(x => x > start - 2 && x <= r.end + 2)) continue;
    bounds.set(start, { type: 'dissolve', duration: len / fps });
  }

  /* ---- shots */
  const starts = [0, ...[...bounds.keys()].filter(b => b > 0 && b < n).sort((x, y) => x - y)];
  // merge shots shorter than 3 frames into their neighbour (detector noise)
  for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 3 && !bounds.get(starts[i])) { starts.splice(i, 1); i--; }
  const shots: RefShot[] = starts.map((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1] : n;
    const tr = i > 0 ? bounds.get(s) ?? null : null;
    return { start: s / fps, end: e / fps, transitionIn: tr, fadeIn: i === 0 ? fadeIn / fps : 0, fadeOut: i === starts.length - 1 ? fadeOut / fps : 0, motion: null };
  });

  /* ---- motion and color per shot */
  const colors: number[] = [];
  shots.forEach((sh, i) => {
    const a = Math.round(sh.start * fps), b = Math.round(sh.end * fps);
    // stay clear of transitions and fades at the shot edges
    const nextTr = shots[i + 1]?.transitionIn;
    const headSkip = Math.ceil(((sh.transitionIn?.type === 'dip' ? sh.transitionIn.duration / 2 : sh.transitionIn?.duration ?? 0) + sh.fadeIn) * fps);
    const tailSkip = Math.ceil(((nextTr?.type === 'dip' ? nextTr.duration / 2 : 0) + sh.fadeOut) * fps);
    const margin = Math.max(1, Math.round((b - a) * 0.06));
    const i0 = a + headSkip + margin, i1 = b - 1 - tailSkip - margin;
    const mid = frames[Math.min(n - 1, Math.round((a + b) / 2))];
    if (mid) for (let k = 0; k < mid.rgb.length; k++) colors.push(mid.rgb[k] / 255);
    if (i1 - i0 < Math.max(6, fps * 0.3)) return;
    const m = estimateMotion(frames[i0].gray, frames[i1].gray, size.w, size.h);
    if (!m) return;
    // extrapolate the move measured between i0 and i1 to the whole shot (constant speed)
    const k = (b - 1 - a) / (i1 - i0);
    const size1 = Math.pow(m.size, k), cx = 0.5 + (m.cx - 0.5) * k, cy = 0.5 + (m.cy - 0.5) * k;
    sh.motion = { cx, cy, size: size1 };
  });

  return { duration: n / fps, fps, width: opts.width ?? 0, height: opts.height ?? 0, hasAudio: !!opts.hasAudio, shots, colors };
}

/* -------------------------------------------------------- motion search */

function sampler(img: Uint8Array, w: number, h: number) {
  return (x: number, y: number) => {
    // bilinear, x/y in pixels; caller guarantees inside
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return (img[y0 * w + x0] * (1 - fx) + img[y0 * w + x1] * fx) * (1 - fy) + (img[y1 * w + x0] * (1 - fx) + img[y1 * w + x1] * fx) * fy;
  };
}

/** Mean |B - A(window)| over B's pixels that map inside A (stride = pixel step). */
function windowCost(A: Uint8Array, B: Uint8Array, w: number, h: number, cx: number, cy: number, size: number, stride: number): number {
  const s = sampler(A, w, h);
  let sum = 0, cnt = 0, tot = 0;
  for (let y = stride >> 1; y < h; y += stride) {
    const ay = (cy + ((y + 0.5) / h - 0.5) * size) * h - 0.5;
    for (let x = stride >> 1; x < w; x += stride) {
      tot++;
      const ax = (cx + ((x + 0.5) / w - 0.5) * size) * w - 0.5;
      if (ax < 0 || ay < 0 || ax > w - 1 || ay > h - 1) continue;
      sum += Math.abs(B[y * w + x] - s(ax, ay)); cnt++;
    }
  }
  return cnt < tot * 0.5 ? Infinity : sum / cnt / 255;
}

function downsample(img: Uint8Array, w: number, h: number, f: number): { img: Uint8Array; w: number; h: number } {
  const W = Math.floor(w / f), H = Math.floor(h / f), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += img[(y * f + j) * w + x * f + i];
    out[y * W + x] = s / (f * f);
  }
  return { img: out, w: W, h: H };
}

/**
 * Find the window of frame A that frame B shows (a zoom and/or pan between
 * them). Returns null when the frames don't line up better than "no move",
 * or the move is too small to matter.
 */
export function estimateMotion(A: Uint8Array, B: Uint8Array, w: number, h: number): RefMotion | null {
  const a4 = downsample(A, w, h, 3), b4 = downsample(B, w, h, 3);
  let best = { cx: 0.5, cy: 0.5, size: 1, cost: windowCost(a4.img, b4.img, a4.w, a4.h, 0.5, 0.5, 1, 1) };
  for (let ls = Math.log(0.6); ls <= Math.log(1.45); ls += 0.035) {
    const size = Math.exp(ls);
    for (let cy = 0.2; cy <= 0.8001; cy += 0.025) for (let cx = 0.2; cx <= 0.8001; cx += 0.025) {
      const c = windowCost(a4.img, b4.img, a4.w, a4.h, cx, cy, size, 1);
      if (c < best.cost) best = { cx, cy, size, cost: c };
    }
  }
  // refine at full resolution
  let step = { s: 0.03, c: 0.0125 };
  best.cost = windowCost(A, B, w, h, best.cx, best.cy, best.size, 1);
  for (let it = 0; it < 4; it++) {
    const base = { ...best };
    for (const ds of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
      const size = base.size * Math.exp(ds * step.s), cx = base.cx + dx * step.c, cy = base.cy + dy * step.c;
      const c = windowCost(A, B, w, h, cx, cy, size, 1);
      if (c < best.cost) best = { cx, cy, size, cost: c };
    }
    step = { s: step.s / 2, c: step.c / 2 };
  }
  const still = windowCost(A, B, w, h, 0.5, 0.5, 1, 1);
  const moved = Math.abs(Math.log(best.size)) > 0.025 || Math.hypot(best.cx - 0.5, best.cy - 0.5) > 0.012;
  if (!moved || !(best.cost < still * 0.75) || best.cost > 0.12) return null;
  return { cx: best.cx, cy: best.cy, size: best.size };
}

/**
 * Start and end crop windows (fractions of the source) that reproduce a
 * reference move, as large as possible while staying inside the picture.
 */
export function motionWindows(m: RefMotion): { from: MotionRect; to: MotionRect } {
  const axis = (c: number) => { const lo = Math.min(0, c - m.size / 2), hi = Math.max(1, c + m.size / 2); return { lo, hi }; };
  const X = axis(m.cx), Y = axis(m.cy);
  const s = Math.min(1 / (X.hi - X.lo), 1 / (Y.hi - Y.lo));
  // centre the slack on each axis
  const place = (A: { lo: number; hi: number }) => { const min = -A.lo * s, max = 1 - A.hi * s; return (min + max) / 2; };
  const fx = place(X), fy = place(Y);
  const from = { x: fx, y: fy, w: s, h: s };
  const to = { x: fx + (m.cx - m.size / 2) * s, y: fy + (m.cy - m.size / 2) * s, w: m.size * s, h: m.size * s };
  return { from, to };
}

/* ---------------------------------------------------------- look match */

interface LookStats { mean: [number, number, number]; p05: number; p50: number; p95: number; chroma: number }

function lookStats(px: number[]): LookStats {
  const n = Math.floor(px.length / 3);
  const lum: number[] = [];
  let r = 0, g = 0, b = 0, ch = 0;
  for (let i = 0; i < n; i++) {
    const R = px[i * 3], G = px[i * 3 + 1], B = px[i * 3 + 2];
    r += R; g += G; b += B;
    lum.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    ch += Math.max(R, G, B) - Math.min(R, G, B);
  }
  lum.sort((x, y) => x - y);
  const q = (f: number) => lum[Math.min(n - 1, Math.floor(f * n))] ?? 0;
  return { mean: [r / n, g / n, b / n], p05: q(0.05), p50: q(0.5), p95: q(0.95), chroma: ch / n };
}

/**
 * Fit a primary grade (exposure, contrast, saturation, temperature, tint,
 * black level) that makes the footage samples look like the reference
 * samples, using the same grading math the player and export use.
 */
export function fitLook(reference: number[], footage: number[]): Grade {
  const target = lookStats(reference);
  const params = { exposure: 0, contrast: 0, saturation: 100, temperature: 0, tint: 0, black: 0 };
  const ranges: Record<keyof typeof params, [number, number, number]> = {
    exposure: [-2, 2, 0.4], contrast: [-60, 60, 15], saturation: [40, 170, 15], temperature: [-60, 60, 12], tint: [-40, 40, 10], black: [-0.3, 0.3, 0.06],
  };
  const make = (p: typeof params): Grade => ({ ...defaultGrade(), exposure: p.exposure, contrast: p.contrast, saturation: p.saturation, temperature: p.temperature, tint: p.tint, lift: { x: 0, y: 0, m: p.black } });
  const cost = (p: typeof params) => {
    const f = gradeFn(make(p));
    const out: number[] = [];
    for (let i = 0; i + 2 < footage.length; i += 3) out.push(...f(footage[i], footage[i + 1], footage[i + 2]));
    const s = lookStats(out);
    return (s.mean[0] - target.mean[0]) ** 2 + (s.mean[1] - target.mean[1]) ** 2 + (s.mean[2] - target.mean[2]) ** 2 +
      2 * ((s.p05 - target.p05) ** 2 + (s.p50 - target.p50) ** 2 + (s.p95 - target.p95) ** 2) + (s.chroma - target.chroma) ** 2;
  };
  let best = cost(params);
  const keys = Object.keys(params) as (keyof typeof params)[];
  const step = Object.fromEntries(keys.map(k => [k, ranges[k][2]])) as Record<keyof typeof params, number>;
  for (let it = 0; it < 40; it++) {
    let improved = false;
    for (const k of keys) for (const dir of [1, -1]) {
      const v = Math.min(ranges[k][1], Math.max(ranges[k][0], params[k] + dir * step[k]));
      if (v === params[k]) continue;
      const trial = { ...params, [k]: v };
      const c = cost(trial);
      if (c < best) { best = c; params[k] = v; improved = true; }
    }
    if (!improved) { for (const k of keys) step[k] /= 2; if (step.exposure < 0.01) break; }
  }
  const g = make(params);
  g.exposure = Math.round(g.exposure * 100) / 100;
  for (const k of ['contrast', 'saturation', 'temperature', 'tint'] as const) g[k] = Math.round(g[k]);
  g.lift.m = Math.round(g.lift.m * 1000) / 1000;
  return g;
}

/* ------------------------------------------------------------- planning */

export interface MatchOptions {
  motion: boolean;
  color: boolean;
  /** Scale footage up to fill the frame when its shape differs from the project's */
  fill: boolean;
  audio: 'reference' | 'footage' | 'both' | 'none';
}

export interface PlannedShot { shotIndex: number; mediaId: string; srcIn: number; start: number; duration: number }

/**
 * Choose where each reference shot comes from in the new footage. Shots are
 * dealt to the footage in turn, and spread evenly through each clip so the
 * edit samples the whole of every clip instead of its first seconds.
 */
export function assignFootage(shots: { duration: number; tail: number }[], footage: { id: string; duration: number; still: boolean }[]): { mediaId: string; srcIn: number }[] {
  if (!footage.length) return [];
  const byClip = new Map<string, number[]>();
  shots.forEach((_, i) => { const f = footage[i % footage.length]; byClip.set(f.id, [...(byClip.get(f.id) ?? []), i]); });
  const out: { mediaId: string; srcIn: number }[] = new Array(shots.length);
  for (const f of footage) {
    const idx = byClip.get(f.id) ?? [];
    if (f.still) { idx.forEach(i => (out[i] = { mediaId: f.id, srcIn: 0 })); continue; }
    const need = idx.map(i => shots[i].duration + shots[i].tail);
    const total = need.reduce((a, b) => a + b, 0);
    if (total <= f.duration) {
      // equal gaps before, between and after the segments
      const gap = (f.duration - total) / (idx.length + 1);
      let t = gap;
      idx.forEach((i, k) => { out[i] = { mediaId: f.id, srcIn: Math.max(0, t) }; t += need[k] + gap; });
    } else {
      // not enough footage: walk through it and wrap around
      let t = 0;
      idx.forEach((i, k) => {
        if (t + need[k] > f.duration) t = 0;
        out[i] = { mediaId: f.id, srcIn: Math.max(0, Math.min(t, f.duration - need[k])) };
        t += need[k];
      });
    }
  }
  return out;
}

/**
 * Replace the timeline with the reference's edit built from the footage.
 * Returns the number of video clips created.
 */
export function buildMatchEdit(p: Project, ref: MediaItem, a: RefAnalysis, footage: MediaItem[], o: MatchOptions, look: Grade | null): number {
  const fps = p.settings.fps;
  const vt = p.tracks.find(t => t.kind === 'video')!;
  const audioTracks = p.tracks.filter(t => t.kind === 'audio');
  p.clips = [];
  const fr = (sec: number) => Math.round(sec * fps);
  const shots = a.shots.map((s, i) => {
    const start = fr(s.start), end = i + 1 < a.shots.length ? fr(a.shots[i + 1].start) : Math.max(fr(s.end), start + 1);
    const next = a.shots[i + 1]?.transitionIn;
    const tail = next?.type === 'dissolve' ? next.duration : 0;
    return { s, start, duration: Math.max(1, end - start), tail };
  });
  const src = assignFootage(shots.map(x => ({ duration: x.duration / fps, tail: x.tail })), footage.map(m => ({ id: m.id, duration: m.duration, still: m.kind === 'image' })));
  const { width: W, height: H } = p.settings;
  let made = 0;
  shots.forEach((x, i) => {
    const pick = src[i];
    const m = mediaOf(p, pick?.mediaId);
    if (!m) return;
    const link = o.audio !== 'reference' && o.audio !== 'none' && m.hasAudio ? uid('l') : null;
    const c = newClip({ trackId: vt.id, kind: 'media', mediaId: m.id, name: m.name, start: x.start, duration: x.duration, srcIn: pick.srcIn, linkId: link });
    if (x.s.transitionIn) {
      const d = Math.max(2, fr(x.s.transitionIn.duration));
      c.transitionIn = { type: x.s.transitionIn.type, duration: Math.min(d, x.duration) };
    }
    if (x.s.fadeIn > 0) c.fadeIn = Math.min(x.duration, fr(x.s.fadeIn));
    if (x.s.fadeOut > 0) c.fadeOut = Math.min(x.duration, fr(x.s.fadeOut));
    if (o.fill && m.width > 0 && m.height > 0) {
      const fit = Math.min(W / m.width, H / m.height), cover = Math.max(W / m.width, H / m.height);
      c.transform.scale = Math.round((cover / fit) * 1000) / 1000;
    }
    if (o.motion && x.s.motion) c.motion = motionWindows(x.s.motion);
    if (o.color && look) c.grade = structuredClone(look);
    p.clips.push(c);
    made++;
    if (link && audioTracks[0]) {
      const ac = newClip({ trackId: audioTracks[0].id, kind: 'media', mediaId: m.id, name: m.name, start: x.start, duration: x.duration, srcIn: pick.srcIn, linkId: link });
      if (x.s.fadeIn > 0) ac.fadeIn = c.fadeIn;
      if (x.s.fadeOut > 0) ac.fadeOut = c.fadeOut;
      p.clips.push(ac);
    }
  });
  if ((o.audio === 'reference' || o.audio === 'both') && ref.hasAudio) {
    const track = o.audio === 'both' ? audioTracks[1] ?? audioTracks[0] : audioTracks[0];
    const end = shots.length ? shots[shots.length - 1].start + shots[shots.length - 1].duration : fr(a.duration);
    if (track) p.clips.push(newClip({ trackId: track.id, kind: 'media', mediaId: ref.id, name: `${ref.name} (audio)`, start: 0, duration: Math.min(end, Math.floor(ref.duration * fps)), srcIn: 0 }));
  }
  return made;
}

/** Short human summary of an analysis. */
export function describeAnalysis(a: RefAnalysis): string {
  const n = a.shots.length;
  const diss = a.shots.filter(s => s.transitionIn?.type === 'dissolve').length;
  const dips = a.shots.filter(s => s.transitionIn?.type === 'dip').length;
  const moves = a.shots.filter(s => s.motion).length;
  const avg = n ? a.duration / n : 0;
  const parts = [`${n} shot${n === 1 ? '' : 's'}`, `average ${avg.toFixed(1)} s`];
  if (diss) parts.push(`${diss} dissolve${diss === 1 ? '' : 's'}`);
  if (dips) parts.push(`${dips} dip${dips === 1 ? '' : 's'} to black`);
  if (moves) parts.push(`${moves} zoom/pan move${moves === 1 ? '' : 's'}`);
  if (a.shots[0]?.fadeIn) parts.push('fade in');
  if (a.shots[n - 1]?.fadeOut) parts.push('fade out');
  return parts.join(' · ');
}

/** Clips on V1 in order (helper for tests and the UI). */
export const v1Clips = (p: Project): Clip[] => clipsOnTrack(p, p.tracks.find(t => t.kind === 'video')!.id);
