/**
 * Neural mask provider: a bundled U²-Net salient-object model (see
 * public/models/README.md) run on-device with ONNX Runtime Web. It handles
 * Subject, Background, People and Object; Sky and the face-part targets stay
 * with the heuristic segmenters. Photos are never uploaded.
 */
import type { AiMaskTarget } from '@shared/edit';
import { guidedFilter, registerMaskProvider, skinLikelihood, type Img, type MaskProvider } from './segmentation';

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./neural.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data.out);
  };
  worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'Segmentation worker crashed')); pending.clear(); worker?.terminate(); worker = null; };
  return worker;
}

function infer(input: Float32Array): Promise<Float32Array> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, base: document.baseURI, size: SIZE, input }, [input.buffer]);
  });
}

/** Bilinear sample of the sRGB image over a rect, as a normalized NCHW tensor. */
function tensorFor(img: Img, rx: number, ry: number, rw: number, rh: number): Float32Array {
  const n = SIZE * SIZE, x = new Float32Array(3 * n);
  let max = 1e-6;
  for (let i = 0; i < img.rgb.length; i++) if (img.rgb[i] > max) max = img.rgb[i];
  for (let y = 0; y < SIZE; y++) {
    const sy = Math.min(img.h - 1, Math.max(0, ry + ((y + 0.5) / SIZE) * rh - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(img.h - 1, y0 + 1), fy = sy - y0;
    for (let xx = 0; xx < SIZE; xx++) {
      const sx = Math.min(img.w - 1, Math.max(0, rx + ((xx + 0.5) / SIZE) * rw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(img.w - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const a = img.rgb[(y0 * img.w + x0) * 3 + c], b = img.rgb[(y0 * img.w + x1) * 3 + c];
        const d = img.rgb[(y1 * img.w + x0) * 3 + c], e = img.rgb[(y1 * img.w + x1) * 3 + c];
        const v = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
        x[c * n + y * SIZE + xx] = (v / max - MEAN[c]) / STD[c];
      }
    }
  }
  return x;
}

/** Run the model over a rect of the image and return a full-size probability map (0 outside the rect). */
async function salient(img: Img, rect?: [number, number, number, number]): Promise<{ p: Float32Array; peak: number }> {
  const [rx, ry, rw, rh] = rect ?? [0, 0, img.w, img.h];
  const out = await infer(tensorFor(img, rx, ry, rw, rh));
  let mn = Infinity, mx = -Infinity;
  for (const v of out) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = Math.max(1e-6, mx - mn);
  const p = new Float32Array(img.w * img.h);
  const x0 = Math.max(0, Math.floor(rx)), x1 = Math.min(img.w, Math.ceil(rx + rw));
  const y0 = Math.max(0, Math.floor(ry)), y1 = Math.min(img.h, Math.ceil(ry + rh));
  for (let y = y0; y < y1; y++) {
    const sy = Math.min(SIZE - 1, Math.max(0, ((y + 0.5 - ry) / rh) * SIZE - 0.5));
    const a0 = Math.floor(sy), a1 = Math.min(SIZE - 1, a0 + 1), fy = sy - a0;
    for (let x = x0; x < x1; x++) {
      const sx = Math.min(SIZE - 1, Math.max(0, ((x + 0.5 - rx) / rw) * SIZE - 0.5));
      const b0 = Math.floor(sx), b1 = Math.min(SIZE - 1, b0 + 1), fx = sx - b0;
      const v = (out[a0 * SIZE + b0] * (1 - fx) + out[a0 * SIZE + b1] * fx) * (1 - fy) + (out[a1 * SIZE + b0] * (1 - fx) + out[a1 * SIZE + b1] * fx) * fy;
      p[y * img.w + x] = (v - mn) / span;
    }
  }
  return { p, peak: mx };
}

/** Snap the upsampled mask to edges in the photo, keeping solid regions solid. */
function refine(img: Img, p: Float32Array): Float32Array {
  const r = Math.max(2, Math.round(Math.min(img.w, img.h) / 200));
  const g = guidedFilter(img.L, p, img.w, img.h, r, 1e-3);
  for (let i = 0; i < g.length; i++) g[i] = Math.min(1, Math.max(0, (g[i] - 0.5) * 1.25 + 0.5));
  return g;
}

const coverage = (m: Float32Array) => { let n = 0; for (const v of m) if (v > 0.5) n++; return n / m.length; };

async function subject(img: Img): Promise<Float32Array | null> {
  const { p, peak } = await salient(img);
  if (peak < 0.2 || coverage(p) < 0.002) return null;
  return refine(img, p);
}

export const neuralProvider: MaskProvider = {
  id: 'photostudio-u2net',
  label: 'PhotoStudio neural segmentation (U²-Net, on this device)',
  kind: 'model',
  supports: (t: AiMaskTarget) => t === 'subject' || t === 'background' || t === 'people' || t === 'object',
  async generate(img, target, opts) {
    switch (target) {
      case 'subject': return subject(img);
      case 'background': { const s = await subject(img); return s ? s.map(v => 1 - v) : null; }
      case 'people': {
        const s = await subject(img);
        if (!s) return null;
        // The model finds the main subject; only call it people when that subject shows skin.
        const skin = skinLikelihood(img);
        let inSubject = 0, area = 0;
        for (let i = 0; i < s.length; i++) { if (s[i] > 0.5) { area++; if (skin[i] > 0.35) inSubject++; } }
        return area && inSubject / area > 0.02 ? s : null;
      }
      case 'object': {
        if (!opts.box) return null;
        const [bx, by, bw, bh] = [opts.box[0] * img.w, opts.box[1] * img.h, opts.box[2] * img.w, opts.box[3] * img.h];
        if (bw < 4 || bh < 4) return null;
        // A little context around the box helps the model separate the object from its surroundings.
        const px = bw * 0.1, py = bh * 0.1;
        const rx = Math.max(0, bx - px), ry = Math.max(0, by - py);
        const rw = Math.min(img.w, bx + bw + px) - rx, rh = Math.min(img.h, by + bh + py) - ry;
        const { p, peak } = await salient(img, [rx, ry, rw, rh]);
        if (peak < 0.2) return null;
        for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (x < bx || x > bx + bw || y < by || y > by + bh) p[y * img.w + x] = 0;
        if (coverage(p) < 0.0005) return null;
        return refine(img, p);
      }
      default: return null;
    }
  },
};

registerMaskProvider(neuralProvider);
