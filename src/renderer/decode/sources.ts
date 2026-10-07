/**
 * Loads source images for the render engine from the catalog, choosing the
 * decoder from the format registry. Results are cached (LRU) because decoding
 * RAW files is the most expensive operation in the app.
 */
import { formatFor } from '@shared/formats';
import type { Photo } from '@shared/types';
import type { SourceImage } from '../engine/pipeline';
import { decodeRaw, type RawMeta } from './libraw';
import { media } from '../api';

export type Quality = 'preview' | 'full';

export class DecodeError extends Error {
  constructor(message: string, public detail: string) { super(message); }
}

const cache = new Map<string, Promise<SourceImage & { rawMeta?: RawMeta }>>();
const MAX_CACHE = 4;

export function loadSource(photo: Pick<Photo, 'id' | 'path' | 'ext' | 'isRaw' | 'width' | 'height'>, quality: Quality, previewEdge = 2560): Promise<SourceImage & { rawMeta?: RawMeta }> {
  const key = `${photo.path}|${quality}|${quality === 'preview' ? previewEdge : 0}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const p = decode(photo, quality, previewEdge, key).catch(e => { cache.delete(key); throw e; });
  cache.set(key, p);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return p;
}

export function loadReference(path: string, edge = 1600) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const fmt = formatFor(ext);
  return loadSource({ id: -1, path, ext, isRaw: !!fmt?.raw, width: 0, height: 0 }, 'preview', edge);
}

export function evictSource(path: string) { for (const k of [...cache.keys()]) if (k.startsWith(path + '|')) cache.delete(k); }

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new DecodeError('Unable to read this file.', `${r.status} ${await r.text().catch(() => '')}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function decode(photo: Pick<Photo, 'id' | 'path' | 'ext' | 'isRaw'>, quality: Quality, edge: number, key: string): Promise<SourceImage & { rawMeta?: RawMeta }> {
  const fmt = formatFor(photo.ext);
  if (!fmt) throw new DecodeError('Unsupported file format.', photo.ext);
  const url = photo.id >= 0 ? media.original(photo.id) : media.reference(photo.path);

  if (fmt.decoder === 'libraw') {
    const bytes = await fetchBytes(url);
    let r;
    try { r = await decodeRaw(bytes, quality === 'preview'); }
    catch (e: any) { throw new DecodeError('Unable to process this RAW file.', String(e?.message ?? e)); }
    const full = quality === 'preview' ? { w: r.width * 2, h: r.height * 2 } : { w: r.width, h: r.height };
    return { id: key, kind: 'u16', width: r.width, height: r.height, data: r.data, primaries: 'prophoto', transfer: 'linear', isRaw: true, fullWidth: full.w, fullHeight: full.h, asShot: r.meta.asShot, rawMeta: r.meta };
  }

  if (fmt.decoder === 'tiff') {
    const u = photo.id >= 0 ? media.decoded(photo.id, quality === 'preview' ? edge : undefined) : null;
    if (!u) throw new DecodeError('TIFF references must be imported first.', photo.path);
    const res = await fetch(u);
    if (!res.ok) throw new DecodeError('Unable to decode this TIFF file.', await res.text());
    const w = Number(res.headers.get('X-Width')), h = Number(res.headers.get('X-Height'));
    const data = new Uint16Array(await res.arrayBuffer());
    return { id: key, kind: 'u16', width: w, height: h, data, primaries: 'srgb', transfer: 'srgb', isRaw: false, fullWidth: w, fullHeight: h, asShot: { temp: 5500, tint: 0 } };
  }

  if (fmt.decoder === 'heif') {
    const bytes = await fetchBytes(url);
    const { width, height, rgba } = await decodeHeif(bytes);
    let bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), width, height), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    bitmap = await maybeResize(bitmap, quality, edge);
    return { id: key, kind: 'bitmap', width: bitmap.width, height: bitmap.height, bitmap, primaries: 'srgb', transfer: 'srgb', isRaw: false, fullWidth: width, fullHeight: height, asShot: { temp: 5500, tint: 0 } };
  }

  // Browser-native formats: JPEG, PNG, WebP, AVIF
  const bytes = await fetchBytes(url);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch (e: any) { throw new DecodeError('Unable to decode this image.', String(e?.message ?? e)); }
  const fullW = bitmap.width, fullH = bitmap.height;
  bitmap = await maybeResize(bitmap, quality, edge);
  return { id: key, kind: 'bitmap', width: bitmap.width, height: bitmap.height, bitmap, primaries: 'srgb', transfer: 'srgb', isRaw: false, fullWidth: fullW, fullHeight: fullH, asShot: { temp: 5500, tint: 0 } };
}

async function maybeResize(bitmap: ImageBitmap, quality: Quality, edge: number) {
  if (quality !== 'preview' || Math.max(bitmap.width, bitmap.height) <= edge) return bitmap;
  const k = edge / Math.max(bitmap.width, bitmap.height);
  const r = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * k), resizeHeight: Math.round(bitmap.height * k), resizeQuality: 'high' });
  bitmap.close();
  return r;
}

let heifWorker: Worker | null = null;
let heifSeq = 0;
function decodeHeif(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  heifWorker ??= new Worker(new URL('./heif.worker.ts', import.meta.url), { type: 'module' });
  const id = ++heifSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.id !== id) return;
      heifWorker!.removeEventListener('message', onMsg);
      ev.data.error ? reject(new DecodeError('Unable to decode this HEIF file.', ev.data.error)) : resolve(ev.data);
    };
    heifWorker!.addEventListener('message', onMsg);
    heifWorker!.postMessage({ id, bytes }, [bytes.buffer]);
  });
}
