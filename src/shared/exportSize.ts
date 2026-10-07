import type { ExportSettings } from './types';

/** Final pixel size for an export (null = keep rendered size). Shared by renderer and main. */
export function targetSize(s: ExportSettings['resize'], w: number, h: number): { width: number; height: number } | null {
  let tw = w, th = h;
  const fit = (bw: number, bh: number) => { const k = Math.min(bw / w, bh / h); tw = w * k; th = h * k; };
  switch (s.mode) {
    case 'none': return null;
    case 'long': fit(w >= h ? s.long : Infinity, h > w ? s.long : Infinity); break;
    case 'short': { const k = s.long / Math.min(w, h); tw = w * k; th = h * k; break; }
    case 'width': { const k = s.width / w; tw = s.width; th = h * k; break; }
    case 'height': { const k = s.height / h; th = s.height; tw = w * k; break; }
    case 'dimensions': fit(s.width, s.height); break;
    case 'megapixels': { const k = Math.sqrt((s.megapixels * 1e6) / (w * h)); tw = w * k; th = h * k; break; }
  }
  if (s.noEnlarge && (tw > w || th > h)) return null;
  return { width: Math.max(1, Math.round(tw)), height: Math.max(1, Math.round(th)) };
}
