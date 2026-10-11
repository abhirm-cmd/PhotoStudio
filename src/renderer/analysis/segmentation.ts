/**
 * On-device segmentation used by AI masks and portrait tools.
 *
 * Two kinds of providers implement `MaskProvider`:
 *  - Built-in heuristic segmenters (this file): sky (seeded region growing with
 *    texture/colour constraints), subject/object (border-contrast + focus
 *    saliency refined with iterative colour models), skin (OkLab skin model),
 *    and eyes/teeth from the platform face detector where available.
 *    All results are refined with an edge-aware guided filter.
 *  - Model providers (see models.ts) that run a user-installed ONNX model.
 * The UI always shows which engine produced a mask.
 */
import { host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { cloneEdit, defaultEdit, type AiMaskTarget } from '@shared/edit';
import { convertMatrix, SPACES, linearSrgbToOklab, linearToSrgb } from '@shared/color';
import { computeGeometry, orientationMatrix } from '../engine/geometry';

export interface Img { w: number; h: number; L: Float32Array; A: Float32Array; B: Float32Array; rgb: Float32Array /* sRGB encoded 0..1, 3ch */ }
export interface MaskBitmap { w: number; h: number; data: Uint8Array }
export interface MaskResult { mask: MaskBitmap; engine: string; kind: 'model' | 'heuristic'; note?: string }

export interface MaskProvider {
  id: string;
  label: string;
  kind: 'model' | 'heuristic';
  supports(target: AiMaskTarget): boolean;
  generate(img: Img, target: AiMaskTarget, opts: { box?: [number, number, number, number] }): Promise<Float32Array | null>;
}

const providers: MaskProvider[] = [];
export function registerMaskProvider(p: MaskProvider) { const i = providers.findIndex(x => x.id === p.id); if (i >= 0) providers.splice(i, 1); providers.unshift(p); }
export function unregisterMaskProvider(id: string) { const i = providers.findIndex(x => x.id === id); if (i >= 0) providers.splice(i, 1); }
export function providerFor(target: AiMaskTarget): MaskProvider { return providers.find(p => p.supports(target)) ?? heuristicProvider; }
export function listProviders() { return [...providers, heuristicProvider]; }

/* ------------------------------------------------------------------ image */

const toSrgb = convertMatrix(SPACES.rec2020, SPACES.srgb);

/** Render the current photo in its oriented frame with no crop, transform, or lens geometry, so pixels map 1:1 to (oriented) source positions. */
export function renderAnalysisImage(edge = 768): { img: Img; orientation: number; flipH: boolean; flipV: boolean } | null {
  const h = host(), r = h.renderer;
  if (!r?.source) return null;
  const dev = useDevelop.getState();
  const e = cloneEdit(dev.edit);
  const d = defaultEdit(dev.isRaw);
  e.crop = { ...d.crop, orientation: e.crop.orientation, flipH: e.crop.flipH, flipV: e.crop.flipV };
  e.transform = d.transform; e.optics = d.optics; e.masks = []; e.portrait = d.portrait;
  e.effects = { ...e.effects, vignetteAmount: 0, grainAmount: 0 };
  const rc = { lens: null, assets: new Map() };
  const g = computeGeometry(e, r.source.width, r.source.height, null);
  const out = r.render(e, rc, { scale: Math.min(1, edge / Math.max(g.outW, g.outH)), noMasks: true }, 'auto');
  const s = r.readSmall(out, edge);
  return { img: toImg(s.data, s.w, s.h), orientation: e.crop.orientation, flipH: e.crop.flipH, flipV: e.crop.flipV };
}

export function toImg(data: Float32Array, w: number, h: number): Img {
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const R = data[i * 4], G = data[i * 4 + 1], Bl = data[i * 4 + 2];
    const lin: [number, number, number] = [
      Math.max(0, toSrgb[0] * R + toSrgb[1] * G + toSrgb[2] * Bl),
      Math.max(0, toSrgb[3] * R + toSrgb[4] * G + toSrgb[5] * Bl),
      Math.max(0, toSrgb[6] * R + toSrgb[7] * G + toSrgb[8] * Bl),
    ];
    const lab = linearSrgbToOklab([Math.min(lin[0], 1), Math.min(lin[1], 1), Math.min(lin[2], 1)]);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    rgb[i * 3] = linearToSrgb(Math.min(1, lin[0])); rgb[i * 3 + 1] = linearToSrgb(Math.min(1, lin[1])); rgb[i * 3 + 2] = linearToSrgb(Math.min(1, lin[2]));
  }
  return { w, h, L, A, B, rgb };
}

/* ------------------------------------------------------------ primitives */

export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0, cnt = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) { acc += src[y * w + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / cnt;
      const xo = x - r, xi = x + r + 1;
      if (xo >= 0) { acc -= src[y * w + xo]; cnt--; }
      if (xi < w) { acc += src[y * w + xi]; cnt++; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) { acc += tmp[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / cnt;
      const yo = y - r, yi = y + r + 1;
      if (yo >= 0) { acc -= tmp[yo * w + x]; cnt--; }
      if (yi < h) { acc += tmp[yi * w + x]; cnt++; }
    }
  }
  return out;
}

/** Edge-aware guided filter (He et al.) with a grayscale guide. */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxBlur(I, w, h, r), mp = boxBlur(p, w, h, r), mIp = boxBlur(Ip, w, h, r), mII = boxBlur(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], vr = mII[i] - mI[i] * mI[i];
    a[i] = cov / (vr + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxBlur(a, w, h, r), mb = boxBlur(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

export function gradient(L: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = L[i + 1] - L[i - 1], gy = L[i + w] - L[i - w];
    g[i] = Math.hypot(gx, gy);
  }
  return g;
}

function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const f = boxBlur(Float32Array.from(m), w, h, r);
  return Uint8Array.from(f, v => (v > 0.001 ? 1 : 0));
}
function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const f = boxBlur(Float32Array.from(m), w, h, r);
  return Uint8Array.from(f, v => (v > 0.999 ? 1 : 0));
}

/** Connected components (4-neighbour). Returns labels and sizes. */
export function components(m: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || labels[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(i); labels[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % w, y = (j / w) | 0;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && m[k] && labels[k] < 0) { labels[k] = id; stack.push(k); }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Fill enclosed holes smaller than maxFrac of the image. */
function fillHoles(m: Uint8Array, w: number, h: number, maxFrac: number): Uint8Array {
  const inv = Uint8Array.from(m, v => 1 - v);
  const { labels, sizes } = components(inv, w, h);
  const touches = new Set<number>();
  for (let x = 0; x < w; x++) { touches.add(labels[x]); touches.add(labels[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { touches.add(labels[y * w]); touches.add(labels[y * w + w - 1]); }
  const out = Uint8Array.from(m);
  for (let i = 0; i < w * h; i++) { const l = labels[i]; if (l >= 0 && !touches.has(l) && sizes[l] < maxFrac * w * h) out[i] = 1; }
  return out;
}

function otsu(v: Float32Array): number {
  const hist = new Float64Array(256);
  for (const x of v) hist[Math.min(255, Math.max(0, Math.round(x * 255)))]++;
  const total = v.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  return thr / 255;
}

/** Diagonal-covariance Gaussian mixture in OkLab, fitted with k-means. */
interface Gmm { mu: number[][]; var: number[][]; w: number[] }
function fitGmm(img: Img, idx: number[], k: number): Gmm {
  const pts = idx.length > 6000 ? idx.filter((_, i) => i % Math.ceil(idx.length / 6000) === 0) : idx;
  const feat = (i: number) => [img.L[i], img.A[i] * 2, img.B[i] * 2];
  let mu: number[][] = [];
  for (let c = 0; c < k; c++) mu.push(feat(pts[Math.floor(((c + 0.5) / k) * pts.length)] ?? 0));
  let assign = new Int32Array(pts.length);
  for (let it = 0; it < 8; it++) {
    for (let p = 0; p < pts.length; p++) {
      const f = feat(pts[p]);
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = (f[0] - mu[c][0]) ** 2 + (f[1] - mu[c][1]) ** 2 + (f[2] - mu[c][2]) ** 2; if (d < bd) { bd = d; best = c; } }
      assign[p] = best;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let p = 0; p < pts.length; p++) { const f = feat(pts[p]); const s = sums[assign[p]]; s[0] += f[0]; s[1] += f[1]; s[2] += f[2]; s[3]++; }
    mu = sums.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : mu[c]));
  }
  const vars = Array.from({ length: k }, () => [0, 0, 0, 0]);
  for (let p = 0; p < pts.length; p++) { const f = feat(pts[p]); const c = assign[p]; for (let d = 0; d < 3; d++) vars[c][d] += (f[d] - mu[c][d]) ** 2; vars[c][3]++; }
  return {
    mu,
    var: vars.map(v => [0, 1, 2].map(d => Math.max(4e-4, v[3] ? v[d] / v[3] : 0.01))),
    w: vars.map(v => Math.max(1e-3, v[3] / Math.max(1, pts.length))),
  };
}
function gmmLogLik(g: Gmm, img: Img, i: number): number {
  const f = [img.L[i], img.A[i] * 2, img.B[i] * 2];
  let best = -Infinity;
  for (let c = 0; c < g.mu.length; c++) {
    let ll = Math.log(g.w[c]);
    for (let d = 0; d < 3; d++) ll += -0.5 * ((f[d] - g.mu[c][d]) ** 2) / g.var[c][d] - 0.5 * Math.log(g.var[c][d]);
    if (ll > best) best = ll;
  }
  return best;
}

/** Iteratively refine a rough binary mask with foreground/background colour models (GrabCut-style, without graph cut). */
function refineWithColorModels(img: Img, rough: Uint8Array, restrict?: Uint8Array, iterations = 3): Float32Array {
  const { w, h } = img;
  let cur = rough;
  let prob = new Float32Array(w * h);
  for (let it = 0; it < iterations; it++) {
    const fgCore = erode(cur, w, h, 2), bgCore = erode(Uint8Array.from(cur, v => 1 - v), w, h, 2);
    const fgIdx: number[] = [], bgIdx: number[] = [];
    for (let i = 0; i < w * h; i++) { if (fgCore[i]) fgIdx.push(i); else if (bgCore[i]) bgIdx.push(i); }
    if (fgIdx.length < 50 || bgIdx.length < 50) break;
    const fg = fitGmm(img, fgIdx, 5), bg = fitGmm(img, bgIdx, 5);
    for (let i = 0; i < w * h; i++) {
      const d = gmmLogLik(fg, img, i) - gmmLogLik(bg, img, i);
      prob[i] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, d * 0.5))));
      if (restrict && !restrict[i]) prob[i] = 0;
    }
    // Spatial coherence: blend with the previous estimate and smooth
    const prev = Float32Array.from(cur);
    const sm = boxBlur(prob, w, h, 2), smPrev = boxBlur(prev, w, h, 3);
    for (let i = 0; i < w * h; i++) prob[i] = 0.6 * sm[i] + 0.4 * smPrev[i];
    cur = Uint8Array.from(prob, v => (v > 0.5 ? 1 : 0));
    cur = keepMain(cur, w, h, 0.25);
    cur = fillHoles(cur, w, h, 0.02);
  }
  return Float32Array.from(cur);
}

/** Keep the largest component plus any component at least `rel` of its size. */
function keepMain(m: Uint8Array, w: number, h: number, rel: number): Uint8Array {
  const { labels, sizes } = components(m, w, h);
  if (!sizes.length) return m;
  const max = Math.max(...sizes);
  const keep = new Set(sizes.map((s, i) => (s >= max * rel && s > w * h * 0.002 ? i : -1)).filter(i => i >= 0));
  return Uint8Array.from(labels, l => (l >= 0 && keep.has(l) ? 1 : 0));
}

/* ------------------------------------------------------------- heuristics */

function skyMask(img: Img): Float32Array | null {
  const { w, h, L, A, B } = img;
  const n = w * h;
  const Ls = boxBlur(L, w, h, 1);
  const g = gradient(Ls, w, h);
  const gs = boxBlur(g, w, h, 2);
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const C = Math.hypot(A[i], B[i]);
    const hue = ((Math.atan2(B[i], A[i]) * 180) / Math.PI + 360) % 360;
    const blue = hue > 190 && hue < 285 && C > 0.015 ? 1 : 0;
    const overcast = C < 0.045 && L[i] > 0.62 ? 0.8 : 0;
    const warmSky = hue > 20 && hue < 110 && L[i] > 0.6 && C < 0.16 ? 0.55 : 0; // sunset skies
    const smooth = Math.max(0, 1 - gs[i] / 0.04);
    score[i] = Math.max(blue, overcast, warmSky) * (0.35 + 0.65 * smooth) * (L[i] > 0.3 ? 1 : 0.2);
  }
  // Seeds: confident pixels in the top band
  const grown = new Uint8Array(n);
  const queue: number[] = [];
  const bandRows = Math.max(2, Math.round(h * 0.06));
  for (let y = 0; y < bandRows; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (score[i] > 0.55) { grown[i] = 1; queue.push(i); } }
  if (queue.length < w * 0.05) return null;
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || grown[j]) continue;
      const step = Math.abs(Ls[j] - Ls[i]) + 0.5 * Math.hypot(A[j] - A[i], B[j] - B[i]);
      if (score[j] > 0.38 && step < 0.035 && g[j] < 0.08) { grown[j] = 1; queue.push(j); }
    }
  }
  let m = fillHoles(grown, w, h, 0.004);
  m = erode(dilate(m, w, h, 1), w, h, 1);
  let area = 0;
  for (const v of m) area += v;
  if (area < n * 0.01) return null;
  return guidedFilter(L, Float32Array.from(m), w, h, Math.max(2, Math.round(Math.min(w, h) / 160)), 2e-4);
}

function saliency(img: Img): Float32Array {
  const { w, h, L, A, B } = img;
  const n = w * h;
  // Background model from the border
  const border: number[] = [];
  const bw = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || y < bw || x >= w - bw || y >= h - bw) border.push(y * w + x);
  const bg = fitGmm(img, border, 6);
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = [L[i], A[i] * 2, B[i] * 2];
    let best = Infinity;
    for (let c = 0; c < bg.mu.length; c++) best = Math.min(best, Math.hypot(f[0] - bg.mu[c][0], f[1] - bg.mu[c][1], f[2] - bg.mu[c][2]));
    dist[i] = best;
  }
  // Focus: local Laplacian energy (in-focus subjects vs. soft backgrounds)
  const lap = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; lap[i] = Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]); }
  const focus = boxBlur(lap, w, h, Math.max(3, Math.round(Math.min(w, h) / 40)));
  const pct = (a: Float32Array, p: number) => { const s = Float32Array.from(a).sort(); return s[Math.floor(p * (s.length - 1))] || 1e-6; };
  const dN = pct(dist, 0.98), fN = pct(focus, 0.98);
  const sal = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const cx = (x / w - 0.5) / 0.45, cy = (y / h - 0.52) / 0.5;
    const center = Math.exp(-(cx * cx + cy * cy));
    sal[i] = Math.min(1, dist[i] / dN) * (0.45 + 0.55 * Math.min(1, focus[i] / fN)) * (0.35 + 0.65 * center);
  }
  return boxBlur(sal, w, h, 2);
}

function subjectMask(img: Img, seedBoost?: Float32Array): Float32Array | null {
  const { w, h } = img;
  const sal = saliency(img);
  if (seedBoost) for (let i = 0; i < sal.length; i++) sal[i] = Math.min(1, sal[i] + seedBoost[i] * 0.5);
  const thr = Math.max(0.12, otsu(sal));
  let rough: Uint8Array = Uint8Array.from(sal, v => (v > thr ? 1 : 0));
  rough = keepMain(rough, w, h, 0.3);
  rough = fillHoles(rough, w, h, 0.05);
  let area = 0;
  for (const v of rough) area += v;
  if (area < w * h * 0.01) return null;
  const refined = refineWithColorModels(img, rough);
  return guidedFilter(img.L, refined, w, h, Math.max(2, Math.round(Math.min(w, h) / 180)), 1e-3);
}

function objectMask(img: Img, box: [number, number, number, number]): Float32Array | null {
  const { w, h } = img;
  const [bx, by, bw, bh] = [box[0] * w, box[1] * h, box[2] * w, box[3] * h];
  const rough = new Uint8Array(w * h), restrict = new Uint8Array(w * h);
  const pad = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const inBox = x >= bx - pad && x <= bx + bw + pad && y >= by - pad && y <= by + bh + pad;
    restrict[i] = inBox ? 1 : 0;
    const ex = (x - (bx + bw / 2)) / (bw * 0.4), ey = (y - (by + bh / 2)) / (bh * 0.4);
    rough[i] = ex * ex + ey * ey <= 1 ? 1 : 0;
  }
  // Saliency inside the box sharpens the initial guess
  const sal = saliency(img);
  let sIn = 0, nIn = 0;
  for (let i = 0; i < w * h; i++) if (restrict[i]) { sIn += sal[i]; nIn++; }
  const mean = sIn / Math.max(1, nIn);
  for (let i = 0; i < w * h; i++) if (restrict[i] && sal[i] > mean * 1.2) rough[i] = 1;
  const refined = refineWithColorModels(img, rough, restrict, 4);
  return guidedFilter(img.L, refined, w, h, 2, 1e-3);
}

function skinLikelihood(img: Img): Float32Array {
  const { L, A, B } = img;
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const C = Math.hypot(A[i], B[i]);
    const hue = ((Math.atan2(B[i], A[i]) * 180) / Math.PI + 360) % 360;
    const hs = Math.max(0, 1 - Math.abs(hue - 58) / 38);
    const cs = C > 0.025 && C < 0.17 ? 1 - Math.abs(C - 0.075) / 0.1 : 0;
    const ls = L[i] > 0.28 && L[i] < 0.95 ? 1 : 0;
    out[i] = Math.max(0, hs * cs * ls);
  }
  return out;
}

async function faceLandmarks(img: Img): Promise<{ box: [number, number, number, number]; eyes: [number, number][]; mouth: [number, number][] }[] | null> {
  const FD = (globalThis as any).FaceDetector;
  if (!FD) return null;
  try {
    const c = new OffscreenCanvas(img.w, img.h);
    const ctx = c.getContext('2d')!;
    const id = ctx.createImageData(img.w, img.h);
    for (let i = 0; i < img.w * img.h; i++) { id.data[i * 4] = img.rgb[i * 3] * 255; id.data[i * 4 + 1] = img.rgb[i * 3 + 1] * 255; id.data[i * 4 + 2] = img.rgb[i * 3 + 2] * 255; id.data[i * 4 + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    const bmp = await createImageBitmap(c);
    const faces = await new FD({ fastMode: false, maxDetectedFaces: 10 }).detect(bmp);
    return faces.map((f: any) => {
      const lm = f.landmarks ?? [];
      const pts = (type: string) => lm.filter((l: any) => l.type === type).flatMap((l: any) => l.locations.map((p: any) => [p.x, p.y] as [number, number]));
      return { box: [f.boundingBox.x, f.boundingBox.y, f.boundingBox.width, f.boundingBox.height], eyes: pts('eye'), mouth: pts('mouth') };
    });
  } catch { return null; }
}

function skinMask(img: Img, faces: Awaited<ReturnType<typeof faceLandmarks>>): Float32Array | null {
  const { w, h } = img;
  const like = skinLikelihood(img);
  // If faces are known, learn this person's skin colour from the face centre
  if (faces?.length) {
    const idx: number[] = [];
    for (const f of faces) {
      const [x, y, fw, fh] = f.box;
      for (let yy = Math.round(y + fh * 0.35); yy < y + fh * 0.75; yy++) for (let xx = Math.round(x + fw * 0.25); xx < x + fw * 0.75; xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h) idx.push(yy * w + xx);
    }
    if (idx.length > 30) {
      const g = fitGmm(img, idx, 2);
      for (let i = 0; i < w * h; i++) {
        const f = [img.L[i], img.A[i] * 2, img.B[i] * 2];
        let best = Infinity;
        for (let c = 0; c < g.mu.length; c++) best = Math.min(best, ((f[0] - g.mu[c][0]) ** 2) / (g.var[c][0] * 9 + 0.01) + ((f[1] - g.mu[c][1]) ** 2 + (f[2] - g.mu[c][2]) ** 2) / (Math.max(g.var[c][1], g.var[c][2]) * 6));
        like[i] = Math.max(like[i] * 0.5, Math.exp(-best));
      }
    }
  }
  let m: Uint8Array = Uint8Array.from(boxBlur(like, w, h, 1), v => (v > 0.4 ? 1 : 0));
  m = dilate(erode(m, w, h, 1), w, h, 1);
  const { labels, sizes } = components(m, w, h);
  const keep = new Set(sizes.map((s, i) => (s > w * h * 0.0015 ? i : -1)).filter(i => i >= 0));
  m = Uint8Array.from(labels, l => (l >= 0 && keep.has(l) ? 1 : 0));
  let area = 0;
  for (const v of m) area += v;
  if (area < w * h * 0.003) return null;
  return guidedFilter(img.L, Float32Array.from(m), w, h, 3, 2e-3);
}

function eyesMask(img: Img, faces: NonNullable<Awaited<ReturnType<typeof faceLandmarks>>>): Float32Array | null {
  const { w, h } = img;
  const out = new Float32Array(w * h);
  let any = false;
  for (const f of faces) {
    const r = Math.max(3, f.box[2] * 0.085);
    for (const [ex, ey] of f.eyes) {
      any = true;
      for (let y = Math.floor(ey - r * 1.2); y <= ey + r * 1.2; y++) for (let x = Math.floor(ex - r * 1.6); x <= ex + r * 1.6; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = ((x - ex) / (r * 1.5)) ** 2 + ((y - ey) / (r * 0.95)) ** 2;
        out[y * w + x] = Math.max(out[y * w + x], d < 1 ? 1 - d * d : 0);
      }
    }
  }
  return any ? out : null;
}

function teethMask(img: Img, faces: NonNullable<Awaited<ReturnType<typeof faceLandmarks>>>): Float32Array | null {
  const { w, h } = img;
  const out = new Float32Array(w * h);
  let any = false;
  for (const f of faces) {
    if (!f.mouth.length) continue;
    const mx = f.mouth.reduce((s, p) => s + p[0], 0) / f.mouth.length, my = f.mouth.reduce((s, p) => s + p[1], 0) / f.mouth.length;
    const rx = f.box[2] * 0.2, ry = f.box[3] * 0.09;
    for (let y = Math.floor(my - ry); y <= my + ry; y++) for (let x = Math.floor(mx - rx); x <= mx + rx; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      const d = ((x - mx) / rx) ** 2 + ((y - my) / ry) ** 2;
      if (d > 1) continue;
      const C = Math.hypot(img.A[i], img.B[i]);
      // Teeth: bright and low-chroma compared with lips/skin
      const t = Math.max(0, Math.min(1, (img.L[i] - 0.5) / 0.15)) * Math.max(0, 1 - C / 0.08);
      if (t > 0) { out[i] = t; any = true; }
    }
  }
  return any ? guidedFilter(img.L, out, w, h, 1, 1e-3) : null;
}

export const heuristicProvider: MaskProvider = {
  id: 'photostudio-heuristic',
  label: 'PhotoStudio on-device segmentation (heuristic)',
  kind: 'heuristic',
  supports: () => true,
  async generate(img, target, opts) {
    switch (target) {
      case 'sky': return skyMask(img);
      case 'subject': return subjectMask(img);
      case 'background': { const s = subjectMask(img); return s ? s.map(v => 1 - v) : null; }
      case 'people': { const skin = skinLikelihood(img); return subjectMask(img, boxBlur(skin, img.w, img.h, 6)); }
      case 'object': return opts.box ? objectMask(img, opts.box) : null;
      case 'skin': case 'face': return skinMask(img, await faceLandmarks(img));
      case 'eyes': { const f = await faceLandmarks(img); return f?.length ? eyesMask(img, f) : null; }
      case 'teeth': { const f = await faceLandmarks(img); return f?.length ? teethMask(img, f) : null; }
      default: return null;
    }
  },
};

/** Whether the platform face detector (used for eyes/teeth) is available. */
export const hasFaceDetector = () => !!(globalThis as any).FaceDetector;

/* ------------------------------------------------- orientation & storage */

/** Map a mask computed in the oriented frame back to source orientation (masks are sampled in source space). */
export function toSourceSpace(m: Float32Array, w: number, h: number, orientation: number, flipH: boolean, flipV: boolean): MaskBitmap {
  const o = ((orientation % 360) + 360) % 360;
  const swap = o === 90 || o === 270;
  const sw = swap ? h : w, sh = swap ? w : h;
  const F = orientationMatrix(o, flipH, flipV); // source-centered → oriented-centered
  const data = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const sx = x + 0.5 - sw / 2, sy = y + 0.5 - sh / 2;
    const ox = F[0] * sx + F[1] * sy + w / 2, oy = F[2] * sx + F[3] * sy + h / 2;
    const xi = Math.min(w - 1, Math.max(0, Math.floor(ox))), yi = Math.min(h - 1, Math.max(0, Math.floor(oy)));
    data[y * sw + x] = Math.round(Math.min(1, Math.max(0, m[yi * w + xi])) * 255);
  }
  return { w: sw, h: sh, data };
}

export async function encodeMaskPng(m: MaskBitmap): Promise<Uint8Array> {
  const c = new OffscreenCanvas(m.w, m.h);
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) { const v = m.data[i]; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export class NoResultError extends Error {}

const MESSAGES: Partial<Record<AiMaskTarget, string>> = {
  sky: 'No sky was found in this photo.',
  subject: 'No clear subject was found. Try Select Object and draw a box around it.',
  background: 'No clear subject was found to separate from the background.',
  people: 'No people were found.',
  skin: 'No skin tones were found.',
  face: 'No skin tones were found.',
  eyes: 'Eye detection needs the system face detector, which is not available on this platform, or no face was found.',
  teeth: 'Teeth detection needs the system face detector, which is not available on this platform, or no smile was found.',
  object: 'Draw a box around the object to select it.',
};

/**
 * Generate a mask for the open photo, store it in the catalog and register it
 * with the renderer. Returns the asset key, engine label and timing.
 */
export async function generateMask(target: AiMaskTarget, key: string, opts: { box?: [number, number, number, number] } = {}): Promise<{ key: string; engine: string; kind: 'model' | 'heuristic'; ms: number }> {
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 20)); // let the UI paint the busy state
  const an = renderAnalysisImage(target === 'eyes' || target === 'teeth' ? 1400 : 768);
  if (!an) throw new NoResultError('Open a photo first.');
  let provider = providerFor(target);
  let m: Float32Array | null = null;
  try { m = await provider.generate(an.img, target, opts); }
  catch (e) {
    console.warn(`mask provider ${provider.id} failed`, e);
    if (provider !== heuristicProvider) { provider = heuristicProvider; m = await provider.generate(an.img, target, opts); }
  }
  if (!m) throw new NoResultError(MESSAGES[target] ?? 'Nothing was detected.');
  const bmp = toSourceSpace(m, an.img.w, an.img.h, an.orientation, an.flipH, an.flipV);
  const png = await encodeMaskPng(bmp);
  const { api } = await import('../api');
  await api.putBlob(key, 'image/png', png);
  host().setAsset({ key, width: bmp.w, height: bmp.h, data: bmp.data });
  return { key, engine: provider.label, kind: provider.kind, ms: performance.now() - t0 };
}
