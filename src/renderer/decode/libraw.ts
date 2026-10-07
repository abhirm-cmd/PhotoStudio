/**
 * Client for the LibRaw WebAssembly decoder (runs in its own worker with pthreads).
 * Implements the same message protocol as libraw-wasm's wrapper, loading the
 * vendored worker from /vendor/libraw so bundlers never rewrite it.
 */
import { solveTempTint } from '@shared/color';

export interface RawDecodeResult {
  width: number; height: number;
  data: Uint16Array;
  meta: RawMeta;
}
export interface RawMeta {
  make?: string; model?: string; lens?: string; iso?: number; shutter?: number; aperture?: number; focal?: number;
  timestamp?: string; width: number; height: number; flip: number;
  asShot: { temp: number; tint: number };
  thumbFormat?: string;
}

class LibRawWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private tail: Promise<unknown> = Promise.resolve();
  busy = 0;

  constructor() {
    this.worker = new Worker(new URL('vendor/libraw/worker.js', document.baseURI), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      data?.error ? p.reject(new Error(data.error)) : p.resolve(data?.out);
    };
    this.worker.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'LibRaw worker crashed')); this.pending.clear(); };
  }

  private run(fn: string, ...args: any[]): Promise<any> {
    const go = () => new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const transfer = args.filter(a => ArrayBuffer.isView(a)).map(a => (a as Uint8Array).buffer);
      this.worker.postMessage({ id, fn, args }, transfer);
    });
    const r = this.tail.then(go, go);
    this.tail = r.then(() => {}, () => {});
    return r;
  }

  /** Run a full job atomically on this worker (open → reads). */
  async job<T>(fn: (w: LibRawWorker) => Promise<T>): Promise<T> {
    this.busy++;
    try { return await fn(this); } finally { this.busy--; }
  }
  open(buf: Uint8Array, settings: Record<string, any>) { return this.run('open', buf, settings); }
  metadata(full = false) { return this.run('metadata', full); }
  imageData() { return this.run('imageData'); }
  thumbnailData() { return this.run('thumbnailData'); }
  terminate() { this.worker.terminate(); }
}

class Pool {
  private workers: LibRawWorker[] = [];
  private queue: Promise<unknown>[] = [];
  constructor(private size: number) {}
  get(): LibRawWorker {
    if (this.workers.length < this.size) { const w = new LibRawWorker(); this.workers.push(w); return w; }
    return this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  }
  reset() { this.workers.forEach(w => w.terminate()); this.workers = []; this.queue = []; }
}

// Separate pools so background thumbnail extraction never blocks the editor.
const editorPool = new Pool(1);
const thumbPool = new Pool(2);

const THUMB_FORMATS = ['unknown', 'jpeg', 'bitmap', 'bitmap16', 'layer', 'rollei', 'h265'];
function metaFrom(m: any): RawMeta {
  if (m && typeof m.thumb_format === 'number') m.thumb_format = THUMB_FORMATS[m.thumb_format] ?? 'unknown';
  if (m && typeof m.timestamp === 'number') m.timestamp = new Date(m.timestamp * 1000);
  const cam = m?.color_data?.cam_mul as number[] | undefined;
  const pre = m?.color_data?.pre_mul as number[] | undefined;
  let asShot = { temp: 5500, tint: 0 };
  if (cam && pre && cam[0] > 0 && cam[1] > 0 && cam[2] > 0 && pre[0] > 0 && pre[1] > 0 && pre[2] > 0) {
    const r = cam[0] / pre[0], g = cam[1] / pre[1], b = cam[2] / pre[2];
    asShot = solveTempTint([r / g, 1, b / g]);
  }
  const lens = m?.lens?.Lens || m?.lens?.makernotes?.Lens || undefined;
  return {
    make: clean(m?.camera_make), model: clean(m?.camera_model), lens: clean(lens),
    iso: m?.iso_speed || undefined, shutter: m?.shutter || undefined, aperture: m?.aperture || undefined, focal: m?.focal_len || undefined,
    timestamp: m?.timestamp instanceof Date && !isNaN(m.timestamp.getTime()) && m.timestamp.getFullYear() > 1971 ? m.timestamp.toISOString() : undefined,
    width: m?.width ?? 0, height: m?.height ?? 0, flip: m?.flip ?? 0, asShot, thumbFormat: m?.thumb_format,
  };
}
const clean = (s: any) => (typeof s === 'string' && s.trim() ? s.replace(/\0/g, '').trim() : undefined);

/**
 * Decode a RAW file to linear 16-bit ProPhoto RGB with the camera's as-shot white balance.
 * `half` uses LibRaw's half-size mode (4x faster, ideal for interactive previews).
 */
export async function decodeRaw(bytes: Uint8Array, half: boolean): Promise<RawDecodeResult> {
  const w = editorPool.get();
  return w.job(async () => {
    await w.open(bytes, {
      outputBps: 16, outputColor: 4, gamm: [1, 1], noAutoBright: true, useCameraWb: true, useCameraMatrix: 1,
      halfSize: half, userQual: half ? 0 : 3, highlight: 0, userFlip: -1,
    });
    const m = await w.metadata(true);
    const img = await w.imageData();
    if (!img?.data) throw new Error('LibRaw returned no image data');
    const data = img.data instanceof Uint16Array ? img.data : new Uint16Array(img.data.buffer ?? img.data);
    return { width: img.width, height: img.height, data, meta: metaFrom(m) };
  });
}

/** Extract the embedded preview (usually a full-size JPEG) and metadata. */
export async function extractRawPreview(bytes: Uint8Array): Promise<{ jpeg?: Uint8Array; rgb?: { width: number; height: number; data: Uint8Array }; meta: RawMeta }> {
  const w = thumbPool.get();
  return w.job(async () => {
    await w.open(bytes, { outputBps: 8, halfSize: true, useCameraWb: true });
    const m = metaFrom(await w.metadata(true));
    let thumb: any = null;
    try { thumb = await w.thumbnailData(); } catch { thumb = null; }
    if (thumb?.format === 'jpeg' && thumb.data?.length > 1000) return { jpeg: thumb.data, meta: m };
    if (thumb?.format === 'bitmap' && thumb.data?.length === thumb.width * thumb.height * 3) return { rgb: { width: thumb.width, height: thumb.height, data: thumb.data }, meta: m };
    // No usable embedded preview: render a fast half-size decode instead
    const img = await w.imageData();
    if (!img?.data) throw new Error('Unable to decode RAW data');
    return { rgb: { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer ?? img.data) }, meta: m };
  });
}

export function resetDecoders() { editorPool.reset(); thumbPool.reset(); }
