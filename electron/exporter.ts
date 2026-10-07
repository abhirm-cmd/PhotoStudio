import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExportSettings, Photo } from '../src/shared/types';
import { iccFor } from './icc';
import { rgbToXyz, inv, SPACES } from '../src/shared/color';

export interface ExportJobItem {
  photo: Photo;
  /** Interleaved RGB pixels in the target space (encoded transfer; linear for DNG). */
  pixels: Uint8Array | Uint16Array;
  width: number;
  height: number;
  seq: number;
}

const sanitize = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();

export function renderFilename(template: string, photo: Photo, seq: number, ext: string): string {
  const d = photo.exif.dateTaken ? new Date(photo.exif.dateTaken) : new Date(photo.importedAt);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = photo.filename.replace(/\.[^.]+$/, '');
  const tokens: Record<string, string> = {
    filename: base, seq: pad(seq, 4), date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    YYYY: String(d.getFullYear()), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), hh: pad(d.getHours()), mm: pad(d.getMinutes()),
    camera: [photo.exif.make, photo.exif.model].filter(Boolean).join(' ') || 'Camera', lens: photo.exif.lens ?? '', rating: String(photo.rating),
    title: photo.iptc.title ?? '', copy: photo.copyName ?? '', preset: photo.presetName ?? '', iso: photo.exif.iso ? String(photo.exif.iso) : '',
  };
  let name = template.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
  name = sanitize(name).replace(/\s+/g, ' ') || base;
  return `${name}.${ext}`;
}

export { targetSize } from '../src/shared/exportSize';
import { targetSize } from '../src/shared/exportSize';

const iccFiles = new Map<string, string>();
function iccPath(id: string) {
  if (!iccFiles.has(id)) {
    const p = path.join(os.tmpdir(), `lumora-${id}.icc`);
    fs.writeFileSync(p, iccFor(id));
    iccFiles.set(id, p);
  }
  return iccFiles.get(id)!;
}

function sharpenParams(s: ExportSettings['sharpen'], scale: number) {
  const amount = { low: 0.6, standard: 1.0, high: 1.5 }[s.amount];
  const sigma = { screen: 0.6, matte: 1.1, glossy: 0.9 }[s.target] * Math.max(0.6, Math.min(1.5, scale));
  return { sigma, m1: 0.5 * amount, m2: 2.5 * amount };
}

function exifFor(photo: Photo, s: ExportSettings): Record<string, any> | null {
  if (s.metadata === 'none') return null;
  const ifd0: Record<string, string> = { Software: 'Lumora Studio' };
  if (photo.iptc.copyright) ifd0.Copyright = photo.iptc.copyright;
  if (photo.iptc.creator) ifd0.Artist = photo.iptc.creator;
  if (s.metadata === 'all') {
    if (photo.exif.make) ifd0.Make = photo.exif.make;
    if (photo.exif.model) ifd0.Model = photo.exif.model;
    if (photo.iptc.caption || photo.iptc.title) ifd0.ImageDescription = photo.iptc.caption || photo.iptc.title!;
    if (photo.exif.dateTaken) ifd0.DateTime = photo.exif.dateTaken.replace('T', ' ').slice(0, 19).replace(/-/g, ':');
  }
  const ifd2: Record<string, string> = {};
  if (s.metadata === 'all') {
    if (photo.exif.iso) ifd2.ISOSpeedRatings = String(photo.exif.iso);
    if (photo.exif.lens) ifd2.LensModel = photo.exif.lens;
    if (photo.exif.dateTaken) ifd2.DateTimeOriginal = ifd0.DateTime ?? '';
    if (photo.exif.focalLength) ifd2.FocalLength = `${Math.round(photo.exif.focalLength * 10)}/10`;
    if (photo.exif.aperture) ifd2.FNumber = `${Math.round(photo.exif.aperture * 10)}/10`;
    if (photo.exif.shutter) ifd2.ExposureTime = photo.exif.shutter >= 1 ? `${photo.exif.shutter}/1` : `1/${Math.round(1 / photo.exif.shutter)}`;
  }
  const out: Record<string, any> = { IFD0: ifd0 };
  if (Object.keys(ifd2).length) out.IFD2 = ifd2;
  if (s.metadata === 'all' && !s.removeLocation && photo.exif.gps) {
    const g = photo.exif.gps;
    const dms = (v: number) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), sec = Math.round(((a - d) * 60 - m) * 60 * 100); return `${d}/1 ${m}/1 ${sec}/100`; };
    out.IFD3 = { GPSLatitudeRef: g.lat >= 0 ? 'N' : 'S', GPSLatitude: dms(g.lat), GPSLongitudeRef: g.lon >= 0 ? 'E' : 'W', GPSLongitude: dms(g.lon) };
  }
  return out;
}

function watermarkSvg(w: number, h: number, wm: NonNullable<ExportSettings['watermark']>) {
  const size = Math.round((Math.min(w, h) * wm.size) / 100);
  const pad = Math.round(size * 0.8);
  const pos = { br: [w - pad, h - pad, 'end'], bl: [pad, h - pad, 'start'], tr: [w - pad, pad + size, 'end'], tl: [pad, pad + size, 'start'], center: [w / 2, h / 2, 'middle'] }[wm.position];
  const esc = wm.text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="${pos[0]}" y="${pos[1]}" text-anchor="${pos[2]}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="white" fill-opacity="${wm.opacity / 100}" style="paint-order:stroke" stroke="black" stroke-opacity="${wm.opacity / 400}" stroke-width="${Math.max(1, size / 30)}">${esc}</text></svg>`);
}

export async function exportOne(item: ExportJobItem, s: ExportSettings): Promise<string | null> {
  const dir = s.subfolder ? path.join(s.destination, sanitize(s.subfolder)) : s.destination;
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = { jpeg: 'jpg', png: 'png', tiff: 'tif', dng: 'dng' }[s.format];
  let out = path.join(dir, renderFilename(s.filenameTemplate, item.photo, item.seq, ext));
  if (fs.existsSync(out)) {
    if (s.conflict === 'skip') return null;
    if (s.conflict === 'unique') { const p = path.parse(out); let i = 2; while (fs.existsSync(out)) out = path.join(p.dir, `${p.name}-${i++}${p.ext}`); }
  }
  const sixteen = item.pixels instanceof Uint16Array;

  if (s.format === 'dng') {
    if (!sixteen) throw new Error('DNG export requires 16-bit data');
    await fs.promises.writeFile(out, writeLinearDng(item.pixels as Uint16Array, item.width, item.height, item.photo));
    return out;
  }

  // sharp infers 16-bit samples from a Uint16Array input.
  let img = sharp(item.pixels, { raw: { width: item.width, height: item.height, channels: 3 }, limitInputPixels: false });
  if (sixteen) img = img.toColorspace('rgb16');
  const size = targetSize(s.resize, item.width, item.height);
  if (size) img = img.resize(size.width, size.height, { kernel: 'lanczos3', fit: 'fill' });
  if (s.sharpen.enabled) img = img.sharpen(sharpenParams(s.sharpen, (size?.width ?? item.width) / 2000));
  if (s.watermark?.enabled && s.watermark.text) {
    const W = size?.width ?? item.width, H = size?.height ?? item.height;
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const input = sixteen ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2) : data;
    img = sharp(input, { raw: { width: info.width, height: info.height, channels: info.channels as 3 } })
      .composite([{ input: watermarkSvg(W, H, s.watermark), top: 0, left: 0 }]);
    if (sixteen) img = img.toColorspace('rgb16');
  }
  img = img.withIccProfile(iccPath(s.colorSpace), { attach: true }).withMetadata({ density: s.ppi });
  const exif = exifFor(item.photo, s);
  if (exif) img = img.withExif(exif as any);
  if (s.format === 'jpeg') img = img.toColorspace('srgb').jpeg({ quality: s.quality, chromaSubsampling: s.quality >= 90 ? '4:4:4' : '4:2:0', mozjpeg: false });
  else if (s.format === 'png') img = s.bitDepth === 16 && sixteen ? img.toColorspace('rgb16').png({ compressionLevel: 6 }) : img.toColorspace('srgb').png({ compressionLevel: 6 });
  else img = s.bitDepth === 16 && sixteen ? img.toColorspace('rgb16').tiff({ compression: 'lzw' }) : img.toColorspace('srgb').tiff({ compression: 'lzw' });
  await img.toFile(out);
  return out;
}

/* --------------------------------------------------------------- Linear DNG */

/**
 * Writes a Linear DNG (PhotometricInterpretation = LinearRaw) holding the
 * rendered 16-bit linear Rec.2020 RGB. Readable by DNG-aware raw processors.
 */
export function writeLinearDng(px: Uint16Array, w: number, h: number, photo: Photo): Buffer {
  const entries: { tag: number; type: number; count: number; value: Buffer | number[] }[] = [];
  const SHORT = 3, LONG = 4, RATIONAL = 5, SRATIONAL = 10, ASCII = 2, BYTE = 1;
  const ascii = (s: string) => Buffer.from(s + '\0', 'latin1');
  const add = (tag: number, type: number, value: number[] | Buffer, count?: number) => entries.push({ tag, type, count: count ?? (Buffer.isBuffer(value) ? value.length : value.length), value });
  const xyzToCam = inv(rgbToXyz(SPACES.rec2020));
  const srat = (v: number) => [Math.round(v * 10000), 10000];
  add(254, LONG, [0]);
  add(256, LONG, [w]); add(257, LONG, [h]);
  add(258, SHORT, [16, 16, 16]);
  add(259, SHORT, [1]);
  add(262, SHORT, [34892]);
  add(271, ASCII, ascii(photo.exif.make ?? 'Lumora'));
  add(272, ASCII, ascii(photo.exif.model ?? 'Lumora Studio'));
  add(273, LONG, [0]); // StripOffsets — patched
  add(274, SHORT, [1]);
  add(277, SHORT, [3]);
  add(278, LONG, [h]);
  add(279, LONG, [w * h * 6]);
  add(284, SHORT, [1]);
  add(305, ASCII, ascii('Lumora Studio'));
  add(50706, BYTE, Buffer.from([1, 4, 0, 0]));
  add(50707, BYTE, Buffer.from([1, 1, 0, 0]));
  add(50708, ASCII, ascii(`Lumora Linear ${[photo.exif.make, photo.exif.model].filter(Boolean).join(' ')}`.trim()));
  add(50717, LONG, [65535]);
  add(50721, SRATIONAL, xyzToCam.flatMap(srat), 9);
  add(50727, RATIONAL, [1, 1, 1, 1, 1, 1], 3);
  add(50728, RATIONAL, [1, 1, 1, 1, 1, 1], 3);
  add(50778, SHORT, [21]);
  entries.sort((a, b) => a.tag - b.tag);
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraOff = 8 + ifdSize;
  const extras: Buffer[] = [];
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  let stripOffsetPos = -1;
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    ifd.writeUInt16LE(e.tag, o); ifd.writeUInt16LE(e.type, o + 2); ifd.writeUInt32LE(e.count, o + 4);
    let data: Buffer;
    if (Buffer.isBuffer(e.value)) data = e.value;
    else {
      const sz = typeSize[e.type];
      data = Buffer.alloc(e.type === RATIONAL || e.type === SRATIONAL ? e.count * 8 : e.count * sz);
      (e.value as number[]).forEach((v, j) => {
        if (e.type === SHORT) data.writeUInt16LE(v, j * 2);
        else if (e.type === LONG || e.type === RATIONAL) data.writeUInt32LE(v >>> 0, j * 4);
        else if (e.type === SRATIONAL) data.writeInt32LE(v, j * 4);
      });
    }
    if (e.tag === 273) stripOffsetPos = o + 8;
    if (data.length <= 4) data.copy(ifd, o + 8);
    else { ifd.writeUInt32LE(extraOff, o + 8); extras.push(data); extraOff += data.length + (data.length & 1); if (data.length & 1) extras.push(Buffer.alloc(1)); }
  });
  ifd.writeUInt32LE(0, ifdSize - 4);
  const pixelOff = extraOff;
  ifd.writeUInt32LE(pixelOff, stripOffsetPos);
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4);
  const pix = Buffer.alloc(w * h * 6);
  for (let i = 0; i < px.length; i++) pix.writeUInt16LE(px[i], i * 2);
  return Buffer.concat([header, ifd, ...extras, pix]);
}
