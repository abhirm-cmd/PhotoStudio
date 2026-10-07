/**
 * Geometric transforms: orientation, lens distortion, perspective (Transform panel),
 * straighten and crop. Coordinates are y-down. "Normalized" coordinates are centered
 * and divided by half the oriented frame's diagonal.
 */
import type { EditParams, Vec2 } from '@shared/edit';
import { inv, mul, mulVec, type Mat3 } from '@shared/color';
import type { LensCorrection } from './lens';

export interface GeometryInfo {
  srcW: number; srcH: number;
  frameW: number; frameH: number;
  halfDiag: number;
  crop: { x: number; y: number; w: number; h: number };
  angle: number; // radians
  hom: Mat3;     // forward: ideal → transformed (normalized)
  homInv: Mat3;
  orient: number[]; // 2x2 row-major oriented-centered → source-centered
  orientFwd: number[]; // source-centered → oriented-centered
  lens: [number, number, number, number];
  outW: number; outH: number; // output pixels at source scale
}

const deg = Math.PI / 180;

export function orientationMatrix(orientation: number, flipH: boolean, flipV: boolean): number[] {
  const o = ((orientation % 360) + 360) % 360;
  // source → oriented: rotate clockwise (y-down) then flip
  const R: Record<number, number[]> = { 0: [1, 0, 0, 1], 90: [0, -1, 1, 0], 180: [-1, 0, 0, -1], 270: [0, 1, -1, 0] };
  const r = R[o] ?? R[0];
  const F = [flipH ? -1 : 1, 0, 0, flipV ? -1 : 1];
  return mul2(F, r);
}
const mul2 = (a: number[], b: number[]) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
const inv2 = (m: number[]) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d]; };

/** Forward perspective/affine transform from Transform panel values. */
export function transformMatrix(t: EditParams['transform'], frameAspect: number): Mat3 {
  const f = 1.15; // virtual focal length in half-diagonal units
  const K: Mat3 = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const Ki = inv(K);
  const tv = (t.vertical / 100) * 22 * deg;
  const th = (t.horizontal / 100) * 22 * deg;
  const Rx: Mat3 = [1, 0, 0, 0, Math.cos(tv), -Math.sin(tv), 0, Math.sin(tv), Math.cos(tv)];
  const Ry: Mat3 = [Math.cos(th), 0, Math.sin(th), 0, 1, 0, -Math.sin(th), 0, Math.cos(th)];
  let P = mul(K, mul(mul(Ry, Rx), Ki));
  // Re-center so the image center stays fixed
  const c = mulVec(P, [0, 0, 1]);
  const cx = c[0] / c[2], cy = c[1] / c[2];
  P = mul([1, 0, -cx, 0, 1, -cy, 0, 0, 1], P);
  // Normalize projective scale so the center keeps unit magnification
  const ca = Math.cos(t.rotate * deg), sa = Math.sin(t.rotate * deg);
  const Rz: Mat3 = [ca, -sa, 0, sa, ca, 0, 0, 0, 1];
  const s = t.scale / 100;
  const asp = 1 + (t.aspect / 100) * 0.5;
  const S: Mat3 = [s * asp, 0, 0, 0, s / asp, 0, 0, 0, 1];
  const ox = (t.offsetX / 100) * 0.5, oy = (t.offsetY / 100) * 0.5;
  const T: Mat3 = [1, 0, ox, 0, 1, oy, 0, 0, 1];
  void frameAspect;
  return mul(T, mul(S, mul(Rz, P)));
}

export function applyHom(H: Mat3, p: Vec2): Vec2 {
  const v = mulVec(H, [p[0], p[1], 1]);
  return [v[0] / v[2], v[1] / v[2]];
}

export function computeGeometry(edit: EditParams, srcW: number, srcH: number, lens: LensCorrection | null, opts: { ignoreCrop?: boolean } = {}): GeometryInfo {
  const c = edit.crop;
  const o = ((c.orientation % 360) + 360) % 360;
  const swap = o === 90 || o === 270;
  const frameW = swap ? srcH : srcW, frameH = swap ? srcW : srcH;
  const halfDiag = 0.5 * Math.hypot(frameW, frameH);
  const hom = transformMatrix(edit.transform, frameW / frameH);
  const orientFwd = orientationMatrix(o, c.flipH, c.flipV);
  const crop = opts.ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : { x: c.x, y: c.y, w: c.w, h: c.h };
  return {
    srcW, srcH, frameW, frameH, halfDiag, crop,
    angle: (c.angle || 0) * deg,
    hom, homInv: inv(hom), orient: inv2(orientFwd), orientFwd,
    lens: lens ? [lens.a, lens.b, lens.c, lens.d] : [0, 0, 0, 1],
    outW: Math.max(1, Math.round(frameW * crop.w)), outH: Math.max(1, Math.round(frameH * crop.h)),
  };
}

const isIdentityLens = (l: GeometryInfo['lens']) => !l[0] && !l[1] && !l[2] && l[3] === 1;
function distort(n: Vec2, l: GeometryInfo['lens']): Vec2 {
  if (isIdentityLens(l)) return n;
  const r = Math.hypot(n[0], n[1]);
  if (r < 1e-9) return n;
  const rd = r * (l[0] * r ** 3 + l[1] * r * r + l[2] * r + l[3]);
  return [n[0] * rd / r, n[1] * rd / r];
}
function undistort(n: Vec2, l: GeometryInfo['lens']): Vec2 {
  if (isIdentityLens(l)) return n;
  let u: Vec2 = [...n];
  for (let i = 0; i < 12; i++) { const d = distort(u, l); u = [u[0] + (n[0] - d[0]), u[1] + (n[1] - d[1])]; }
  return u;
}

/** Output uv (0..1 over the crop) → source uv (0..1). Mirrors the GLSL `outToSrc`. */
export function outToSrc(g: GeometryInfo, uv: Vec2): Vec2 {
  const fx = (g.crop.x + uv[0] * g.crop.w) * g.frameW - g.frameW / 2;
  const fy = (g.crop.y + uv[1] * g.crop.h) * g.frameH - g.frameH / 2;
  const ca = Math.cos(g.angle), sa = Math.sin(g.angle);
  const n: Vec2 = [(ca * fx - sa * fy) / g.halfDiag, (sa * fx + ca * fy) / g.halfDiag];
  const ideal = applyHom(g.homInv, n);
  const d = distort(ideal, g.lens);
  const s = [g.orient[0] * d[0] + g.orient[1] * d[1], g.orient[2] * d[0] + g.orient[3] * d[1]];
  return [(s[0] * g.halfDiag + g.srcW / 2) / g.srcW, (s[1] * g.halfDiag + g.srcH / 2) / g.srcH];
}

/** Source uv → output uv (inverse of outToSrc). Used to place on-image handles. */
export function srcToOut(g: GeometryInfo, src: Vec2): Vec2 {
  const sx = (src[0] * g.srcW - g.srcW / 2) / g.halfDiag, sy = (src[1] * g.srcH - g.srcH / 2) / g.halfDiag;
  const o = g.orientFwd;
  const d: Vec2 = [o[0] * sx + o[1] * sy, o[2] * sx + o[3] * sy];
  const ideal = undistort(d, g.lens);
  const n = applyHom(g.hom, ideal);
  const ca = Math.cos(-g.angle), sa = Math.sin(-g.angle);
  const fx = (ca * n[0] - sa * n[1]) * g.halfDiag + g.frameW / 2;
  const fy = (sa * n[0] + ca * n[1]) * g.halfDiag + g.frameH / 2;
  return [(fx / g.frameW - g.crop.x) / g.crop.w, (fy / g.frameH - g.crop.y) / g.crop.h];
}

/** Largest crop of the given aspect (w/h in pixels) centered in the frame that stays inside the image after rotation. */
export function maxCropForAngle(frameW: number, frameH: number, angleDeg: number, aspect: number): { w: number; h: number } {
  const a = Math.abs(angleDeg) * deg;
  const cos = Math.cos(a), sin = Math.sin(a);
  // For a rectangle w x h (aspect) rotated by a inside W x H: w*cos + h*sin <= W, w*sin + h*cos <= H
  const hFromW = (w: number) => w / aspect;
  let lo = 0, hi = frameW;
  for (let i = 0; i < 40; i++) {
    const w = (lo + hi) / 2, h = hFromW(w);
    if (w * cos + h * sin <= frameW && w * sin + h * cos <= frameH) lo = w; else hi = w;
  }
  return { w: lo / frameW, h: hFromW(lo) / frameH };
}

export const ASPECTS: Record<string, number | null> = {
  free: null, original: -1, '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '3:2': 3 / 2, '2:3': 2 / 3, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16,
};
