import React, { useEffect } from 'react';
import { create } from 'zustand';
import { useView } from '../engine/host';
import { host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { frameGeometry, constrain, cropAspect, maxRectAt, rectValid, type Rect } from './crop';

export type CropGuide = 'thirds' | 'grid' | 'golden' | 'diagonal' | 'none';
export const useCropUi = create<{ guide: CropGuide; set(g: CropGuide): void }>(set => ({ guide: 'thirds', set: g => set({ guide: g }) }));

function geom() {
  const dev = useDevelop.getState();
  const src = host().renderer?.source;
  if (!src) return null;
  return frameGeometry(dev.edit, src.width, src.height, host().renderContext(dev.edit).lens);
}

type Handle = 'move' | 'rotate' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function CropOverlay() {
  const m = useView(s => s.mapping)!;
  const crop = useDevelop(s => s.edit.crop);
  const guide = useCropUi(s => s.guide);
  const r = { x: m.ox + crop.x * m.dw, y: m.oy + crop.y * m.dh, w: crop.w * m.dw, h: crop.h * m.dh };

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('input')) { useDevelop.getState().set({ tool: 'none' }); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const start = (h: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const g0 = geom();
    if (!g0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const dev = useDevelop.getState();
    const c0: Rect = { x: dev.edit.crop.x, y: dev.edit.crop.y, w: dev.edit.crop.w, h: dev.edit.crop.h };
    const angle0 = dev.edit.crop.angle;
    const x0 = e.clientX, y0 = e.clientY;
    const box = el.closest('.viewer')!.getBoundingClientRect();
    const mm = useView.getState().mapping!;
    const cxPx = box.left + mm.ox + (c0.x + c0.w / 2) * mm.dw, cyPx = box.top + mm.oy + (c0.y + c0.h / 2) * mm.dh;
    const a0 = Math.atan2(y0 - cyPx, x0 - cxPx);
    const aspect = cropAspect(dev.edit, g0);
    const pxAspect = g0.frameW / g0.frameH; // uv → pixel aspect factor

    const move = (ev: PointerEvent) => {
      const du = (ev.clientX - x0) / mm.dw, dv = (ev.clientY - y0) / mm.dh;
      useDevelop.getState().setEdit(ed => {
        if (h === 'rotate') {
          const a = Math.atan2(ev.clientY - cyPx, ev.clientX - cxPx);
          let deg = angle0 + ((a - a0) * 180) / Math.PI;
          if (ev.shiftKey) deg = Math.round(deg);
          ed.crop.angle = Math.max(-45, Math.min(45, Math.round(deg * 100) / 100));
          const g = geom()!;
          const gg = { ...g, angle: (ed.crop.angle * Math.PI) / 180 };
          // Straightening shrinks the crop (same aspect) so it stays inside the rotated image
          const r0 = rectValid(gg, c0) ? c0 : maxRectAt(gg, c0.x + c0.w / 2, c0.y + c0.h / 2, (c0.w * g.frameW) / (c0.h * g.frameH));
          Object.assign(ed.crop, constrain(gg, r0));
          return;
        }
        let { x, y, w, h: hh } = c0;
        if (h === 'move') { x += du; y += dv; }
        else {
          if (h.includes('w')) { x = c0.x + du; w = c0.w - du; }
          if (h.includes('e')) { w = c0.w + du; }
          if (h.includes('n')) { y = c0.y + dv; hh = c0.h - dv; }
          if (h.includes('s')) { hh = c0.h + dv; }
          const minU = 32 / mm.dw, minV = 32 / mm.dh;
          if (w < minU) { if (h.includes('w')) x -= minU - w; w = minU; }
          if (hh < minV) { if (h.includes('n')) y -= minV - hh; hh = minV; }
          if (aspect) {
            // Keep pixel aspect: w_px / h_px = aspect  →  w = aspect * h / pxAspect
            const horizontalOnly = h === 'e' || h === 'w', verticalOnly = h === 'n' || h === 's';
            if (verticalOnly) { const nw = (aspect * hh) / pxAspect; x = c0.x + (c0.w - nw) / 2; w = nw; }
            else if (horizontalOnly) { const nh = (w * pxAspect) / aspect; y = c0.y + (c0.h - nh) / 2; hh = nh; }
            else {
              const nh = (w * pxAspect) / aspect;
              if (h.includes('n')) y = c0.y + c0.h - nh;
              hh = nh;
            }
          }
        }
        const g = geom()!;
        let next: Rect = { x, y, w, h: hh };
        if (h === 'move') next = constrain(g, next);
        else if (!rectOk(g, next)) {
          // Shrink the drag until the rect is valid instead of jumping
          let lo = 0, hi = 1;
          const lerp = (t: number): Rect => ({ x: c0.x + (x - c0.x) * t, y: c0.y + (y - c0.y) * t, w: c0.w + (w - c0.w) * t, h: c0.h + (hh - c0.h) * t });
          for (let i = 0; i < 18; i++) { const t = (lo + hi) / 2; if (rectOk(g, lerp(t))) lo = t; else hi = t; }
          next = lerp(lo);
        }
        Object.assign(ed.crop, next);
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      useDevelop.getState().commit(h === 'rotate' ? 'Straighten' : 'Crop');
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const H = (h: Handle, style: React.CSSProperties, cls: string) => <div className={`crop-handle interactive ${cls}`} style={style} onPointerDown={start(h)} />;
  const lines: [number, number, number, number][] = [];
  const add = (fx: number[], fy: number[]) => { for (const f of fx) lines.push([r.x + f * r.w, r.y, r.x + f * r.w, r.y + r.h]); for (const f of fy) lines.push([r.x, r.y + f * r.h, r.x + r.w, r.y + f * r.h]); };
  if (guide === 'thirds') add([1 / 3, 2 / 3], [1 / 3, 2 / 3]);
  if (guide === 'grid') add([1, 2, 3, 4, 5].map(i => i / 6), [1, 2, 3, 4, 5].map(i => i / 6));
  if (guide === 'golden') add([0.382, 0.618], [0.382, 0.618]);
  if (guide === 'diagonal') { lines.push([r.x, r.y, r.x + r.w, r.y + r.h], [r.x + r.w, r.y, r.x, r.y + r.h]); }

  return (
    <>
      <div className="crop-rotate interactive" onPointerDown={start('rotate')} title="Drag outside the crop to straighten" />
      <svg className="crop-svg">
        <defs><mask id="cropHole"><rect x="0" y="0" width="100%" height="100%" fill="white" /><rect x={r.x} y={r.y} width={r.w} height={r.h} fill="black" /></mask></defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(8,8,10,0.62)" mask="url(#cropHole)" />
        {lines.map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />)}
        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1} />
      </svg>
      <div className="crop-move interactive" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} onPointerDown={start('move')} onDoubleClick={() => useDevelop.getState().set({ tool: 'none' })} />
      {H('nw', { left: r.x, top: r.y }, 'corner nw')}
      {H('ne', { left: r.x + r.w, top: r.y }, 'corner ne')}
      {H('sw', { left: r.x, top: r.y + r.h }, 'corner sw')}
      {H('se', { left: r.x + r.w, top: r.y + r.h }, 'corner se')}
      {H('n', { left: r.x + r.w / 2, top: r.y }, 'edge n')}
      {H('s', { left: r.x + r.w / 2, top: r.y + r.h }, 'edge s')}
      {H('w', { left: r.x, top: r.y + r.h / 2 }, 'edge w')}
      {H('e', { left: r.x + r.w, top: r.y + r.h / 2 }, 'edge e')}
      <div className="crop-size" style={{ left: r.x + r.w / 2, top: r.y + r.h + 10 }}>{cropPixels(crop, m)}</div>
    </>
  );
}

const rectOk = rectValid;

function cropPixels(c: { w: number; h: number; angle: number }, m: { outW: number; outH: number }) {
  return `${Math.round(c.w * m.outW)} × ${Math.round(c.h * m.outH)}${c.angle ? ` · ${c.angle.toFixed(1)}°` : ''}`;
}

/** Reset crop to the full frame (with current straighten angle). */
export function resetCrop() {
  const g = geom();
  useDevelop.getState().setEdit(e => {
    e.crop.angle = 0;
    Object.assign(e.crop, { x: 0, y: 0, w: 1, h: 1, aspect: 'original' });
    void g;
  }, 'Reset Crop');
}

export function setCropAspect(aspect: string) {
  const g0 = geom();
  if (!g0) return;
  useDevelop.getState().setEdit(e => {
    e.crop.aspect = aspect;
    const a = cropAspect(e, g0);
    if (a == null) return;
    const cur = e.crop;
    const r = maxRectAt(g0, cur.x + cur.w / 2, cur.y + cur.h / 2, a);
    // Keep it no larger than the current crop's area if the user had a tighter crop
    const k = Math.min(1, Math.sqrt((cur.w * cur.h) / (r.w * r.h)) * 1.0001);
    const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
    const w = r.w * (cur.w < 0.999 || cur.h < 0.999 ? k : 1), h = r.h * (cur.w < 0.999 || cur.h < 0.999 ? k : 1);
    Object.assign(e.crop, constrain(g0, { x: cx - w / 2, y: cy - h / 2, w, h }));
  }, `Crop ${aspect}`);
}

export function setStraighten(angle: number, commit = false) {
  const g0 = geom();
  if (!g0) return;
  useDevelop.getState().setEdit(e => {
    const c0 = { x: e.crop.x, y: e.crop.y, w: e.crop.w, h: e.crop.h };
    e.crop.angle = angle;
    const g = { ...g0, angle: (angle * Math.PI) / 180 };
    const asp = (c0.w * g.frameW) / (c0.h * g.frameH);
    Object.assign(e.crop, rectValid(g, c0) ? c0 : maxRectAt(g, c0.x + c0.w / 2, c0.y + c0.h / 2, asp));
    Object.assign(e.crop, constrain(g, e.crop));
  }, commit ? 'Straighten' : undefined);
}
