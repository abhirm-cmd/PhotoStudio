import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

sharp.cache({ memory: 256, files: 0, items: 64 });
sharp.concurrency(Math.max(1, Math.min(4, (globalThis as any).navigator?.hardwareConcurrency ?? 4)));

export const THUMB_SIZE = 480;
export const PREVIEW_SIZE = 2048;

export class PreviewCache {
  constructor(public dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private bucket(id: number) { const d = path.join(this.dir, (id % 256).toString(16).padStart(2, '0')); fs.mkdirSync(d, { recursive: true }); return d; }
  thumbPath(id: number) { return path.join(this.bucket(id), `${id}-t.jpg`); }
  previewPath(id: number) { return path.join(this.bucket(id), `${id}-p.jpg`); }
  has(id: number) { return fs.existsSync(this.thumbPath(id)); }
  remove(id: number) { for (const p of [this.thumbPath(id), this.previewPath(id)]) fs.rmSync(p, { force: true }); }
  copy(from: number, to: number) {
    for (const [a, b] of [[this.thumbPath(from), this.thumbPath(to)], [this.previewPath(from), this.previewPath(to)]]) if (fs.existsSync(a)) fs.copyFileSync(a, b);
  }
  sizeBytes(): number {
    let total = 0;
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
    if (fs.existsSync(this.dir)) walk(this.dir);
    return total;
  }
  clear() { fs.rmSync(this.dir, { recursive: true, force: true }); fs.mkdirSync(this.dir, { recursive: true }); }

  /** Build thumbnail + preview from any input sharp can read (file path or encoded buffer). */
  async build(id: number, input: string | Buffer, opts: { angle?: number } = {}): Promise<{ width: number; height: number }> {
    const img = sharp(input, { failOn: 'none', limitInputPixels: false });
    // Explicit angle (from RAW orientation) or EXIF auto-orientation
    const base = opts.angle !== undefined ? img.rotate(opts.angle) : img.rotate();
    const meta = await sharp(input, { failOn: 'none', limitInputPixels: false }).metadata();
    const swap = opts.angle !== undefined ? opts.angle % 180 !== 0 : (meta.orientation ?? 1) >= 5;
    const width = (swap ? meta.height : meta.width) ?? 0;
    const height = (swap ? meta.width : meta.height) ?? 0;
    const preview = await base.clone().resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true }).toColorspace('srgb').jpeg({ quality: 86, mozjpeg: false }).toBuffer();
    fs.writeFileSync(this.previewPath(id), preview);
    await sharp(preview).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(this.thumbPath(id));
    return { width, height };
  }

  /** Store a renderer-produced (edited) render as the new thumbnail + preview. */
  async storeRendered(id: number, jpeg: Buffer) {
    fs.writeFileSync(this.previewPath(id), jpeg);
    await sharp(jpeg).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(this.thumbPath(id));
  }
}

/**
 * Decode a non-RAW file to 16-bit linear-ready RGB for the editor
 * (used for TIFF and other formats the browser cannot decode).
 * Returns sRGB-encoded 16-bit samples; the renderer linearizes.
 */
export async function decodeToRgb16(file: string, maxEdge?: number): Promise<{ width: number; height: number; data: Buffer }> {
  let img = sharp(file, { failOn: 'none', limitInputPixels: false }).rotate().toColorspace('rgb16');
  if (maxEdge) img = img.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.removeAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Fast partial content hash for duplicate detection: size + head + middle + tail. */
export async function quickHash(file: string, size: number): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha1');
  h.update(String(size));
  const fd = await fs.promises.open(file, 'r');
  try {
    const chunk = 128 * 1024;
    const offsets = size <= chunk * 3 ? [0] : [0, Math.floor(size / 2) - chunk / 2, size - chunk];
    for (const off of offsets) {
      const buf = Buffer.alloc(Math.min(chunk * (size <= chunk * 3 ? 3 : 1), size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, off);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fd.close(); }
  return h.digest('hex');
}
