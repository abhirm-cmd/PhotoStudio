/** Crop constraints: keep the crop rectangle inside the (rotated, corrected) image. */
import type { EditParams } from '@shared/edit';
import { computeGeometry, outToSrc, maxCropForAngle, ASPECTS, type GeometryInfo } from '../engine/geometry';
import type { LensCorrection } from '../engine/lens';

export type Rect = { x: number; y: number; w: number; h: number };

/** Uncropped geometry (the frame the crop rectangle lives in). */
export function frameGeometry(e: EditParams, srcW: number, srcH: number, lens: LensCorrection | null): GeometryInfo {
  return computeGeometry(e, srcW, srcH, lens, { ignoreCrop: true });
}

const inside = (g: GeometryInfo, u: number, v: number) => {
  const s = outToSrc(g, [u, v]);
  return s[0] >= -1e-4 && s[0] <= 1 + 1e-4 && s[1] >= -1e-4 && s[1] <= 1 + 1e-4;
};

export function rectValid(g: GeometryInfo, r: Rect) {
  if (r.x < -1e-4 || r.y < -1e-4 || r.x + r.w > 1 + 1e-4 || r.y + r.h > 1 + 1e-4) return false;
  // corners and edge midpoints (lens distortion can bow edges)
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) if (!inside(g, r.x + u * r.w, r.y + v * r.h)) return false;
  return true;
}

/** Pixel aspect (w/h) the crop must keep, or null for free. */
export function cropAspect(e: EditParams, g: GeometryInfo): number | null {
  const a = ASPECTS[e.crop.aspect];
  if (a == null) return null;
  if (a === -1) return g.frameW / g.frameH;
  return a;
}

/** Largest valid rect of the given aspect around a center. */
export function maxRectAt(g: GeometryInfo, cx: number, cy: number, aspect: number | null): Rect {
  const asp = aspect ?? g.frameW / g.frameH;
  const base = maxCropForAngle(g.frameW, g.frameH, (g.angle * 180) / Math.PI, asp);
  let lo = 0, hi = 1;
  const at = (k: number): Rect => ({ x: cx - (base.w * k) / 2, y: cy - (base.h * k) / 2, w: base.w * k, h: base.h * k });
  for (let i = 0; i < 24; i++) { const k = (lo + hi) / 2; if (rectValid(g, at(k))) lo = k; else hi = k; }
  return at(lo);
}

/** Bring a rect back inside the image: first by sliding toward the center, then by shrinking. */
export function constrain(g: GeometryInfo, r: Rect): Rect {
  if (rectValid(g, r)) return r;
  const cx = 0.5 - r.w / 2, cy = 0.5 - r.h / 2;
  let lo = 0, hi = 1;
  const slide = (t: number): Rect => ({ ...r, x: r.x + (cx - r.x) * t, y: r.y + (cy - r.y) * t });
  if (rectValid(g, slide(1))) {
    for (let i = 0; i < 20; i++) { const t = (lo + hi) / 2; if (rectValid(g, slide(t))) hi = t; else lo = t; }
    return slide(hi);
  }
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  lo = 0; hi = 1;
  const shrink = (k: number): Rect => ({ x: c.x - (r.w * k) / 2, y: c.y - (r.h * k) / 2, w: r.w * k, h: r.h * k });
  for (let i = 0; i < 24; i++) { const k = (lo + hi) / 2; if (rectValid(g, shrink(k))) lo = k; else hi = k; }
  const s = shrink(lo);
  return s.w > 0.02 && s.h > 0.02 ? s : maxRectAt(g, 0.5, 0.5, (r.w * g.frameW) / (r.h * g.frameH));
}

/** Apply an aspect ratio to the current crop, keeping its center. */
export function withAspect(g: GeometryInfo, r: Rect, aspect: number | null): Rect {
  if (aspect == null) return r;
  const area = r.w * g.frameW * r.h * g.frameH;
  let wPx = Math.sqrt(area * aspect), hPx = wPx / aspect;
  const k = Math.min(1, g.frameW / wPx, g.frameH / hPx);
  wPx *= k; hPx *= k;
  const w = wPx / g.frameW, h = hPx / g.frameH;
  return constrain(g, { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h });
}
