import exifr from 'exifr';
import type { IptcMeta, PhotoExif } from '../src/shared/types';

/** Read EXIF/IPTC/XMP metadata. Never throws: broken metadata must not break import. */
export async function readMetadata(file: string): Promise<{ exif: PhotoExif; iptc: IptcMeta; keywords: string[] }> {
  try {
    const m: any = await exifr.parse(file, {
      tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: false, interop: false, makerNote: false,
      translateValues: false, reviveValues: true, mergeOutput: true,
    });
    if (!m) return { exif: {}, iptc: {}, keywords: [] };
    const exif: PhotoExif = {
      make: clean(m.Make),
      model: clean(m.Model),
      lens: clean(m.LensModel ?? m.Lens),
      iso: num(m.ISO ?? m.ISOSpeedRatings ?? m.PhotographicSensitivity),
      aperture: num(m.FNumber ?? m.ApertureValue),
      shutter: num(m.ExposureTime),
      focalLength: num(m.FocalLength),
      dateTaken: toIso(m.DateTimeOriginal ?? m.CreateDate ?? m.DateTimeDigitized ?? m.ModifyDate),
      gps: typeof m.latitude === 'number' && typeof m.longitude === 'number' ? { lat: m.latitude, lon: m.longitude, alt: num(m.GPSAltitude) } : null,
      orientation: typeof m.Orientation === 'number' ? m.Orientation : undefined,
      width: num(m.ExifImageWidth ?? m.ImageWidth),
      height: num(m.ExifImageHeight ?? m.ImageHeight),
    };
    if (exif.model && exif.make && exif.model.toLowerCase().startsWith(exif.make.toLowerCase())) exif.model = exif.model.slice(exif.make.length).trim();
    const iptc: IptcMeta = {
      title: clean(m.ObjectName ?? m.title?.value ?? m.title),
      caption: clean(m.Caption ?? m['Caption-Abstract'] ?? m.description?.value ?? m.ImageDescription),
      creator: clean(m.Byline ?? m.creator ?? m.Artist),
      copyright: clean(m.CopyrightNotice ?? m.rights?.value ?? m.Copyright),
      location: clean([m.City, m.State ?? m['Province-State'], m.Country ?? m['Country-PrimaryLocationName']].filter(Boolean).join(', ')),
    };
    const kw = m.Keywords ?? m.subject;
    const keywords = (Array.isArray(kw) ? kw : kw ? [kw] : []).map(String).map(s => s.trim()).filter(Boolean);
    return { exif: strip(exif), iptc: strip(iptc), keywords };
  } catch {
    return { exif: {}, iptc: {}, keywords: [] };
  }
}

function clean(v: any): string | undefined {
  if (v == null) return undefined;
  const s = String(v).replace(/\0/g, '').trim();
  return s && s !== '[object Object]' ? s : undefined;
}
function num(v: any): number | undefined {
  const n = typeof v === 'number' ? v : Array.isArray(v) ? Number(v[0]) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function toIso(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(String(v).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
