import React, { useEffect, useRef, useState } from 'react';
import { useView } from '../engine/host';
import { useDevelop } from '../store/develop';
import { formatExposure } from '../library/format';
import type { Photo } from '@shared/types';

const ZONES = [
  { key: 'blacks', label: 'Blacks' }, { key: 'shadows', label: 'Shadows' }, { key: 'exposure', label: 'Exposure' },
  { key: 'highlights', label: 'Highlights' }, { key: 'whites', label: 'Whites' },
] as const;

/** Live RGB histogram of the rendered image. Drag a zone horizontally to adjust that tone range. */
export function Histogram({ photo }: { photo: Photo | null }) {
  const histo = useView(s => s.histo);
  const clipping = useDevelop(s => s.clipping);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zone, setZone] = useState<number | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth * dpr, H = c.clientHeight * dpr;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!histo) return;
    // Smooth + log-ish scale so small peaks stay visible
    const max = Math.max(1, ...[histo.r, histo.g, histo.b].flatMap(a => Array.from(a.slice(2, 254))));
    const path = (arr: Uint32Array) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const v = (arr[Math.max(0, i - 1)] + 2 * arr[i] + arr[Math.min(255, i + 1)]) / 4;
        const y = H - Math.min(1, Math.sqrt(v / max)) * (H - 6 * dpr);
        ctx.lineTo((i / 255) * W, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
    };
    ctx.globalCompositeOperation = 'lighter';
    const cols: [Uint32Array, string][] = [[histo.r, 'rgba(235,70,70,0.55)'], [histo.g, 'rgba(70,200,90,0.5)'], [histo.b, 'rgba(70,120,255,0.6)']];
    for (const [a, col] of cols) { path(a); ctx.fillStyle = col; ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    path(histo.l);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = dpr;
    ctx.stroke();
  }, [histo]);

  const drag = (i: number) => (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const key = ZONES[i].key;
    const x0 = e.clientX;
    const dev = useDevelop.getState();
    const v0 = dev.edit[key] as number;
    const width = el.parentElement!.clientWidth;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / width;
      useDevelop.getState().setEdit(ed => { ed[key] = key === 'exposure' ? Math.round(Math.max(-5, Math.min(5, v0 + d * 4)) * 100) / 100 : Math.round(Math.max(-100, Math.min(100, v0 + d * 200))); });
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); useDevelop.getState().commit(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const clipLo = histo ? histo.clipLo / Math.max(1, histo.total) : 0, clipHi = histo ? histo.clipHi / Math.max(1, histo.total) : 0;
  return (
    <>
      <div className="histogram" aria-label="Histogram">
        <canvas ref={canvas} />
        <div className="zones">
          {ZONES.map((z, i) => <div key={z.key} onPointerEnter={() => setZone(i)} onPointerLeave={() => setZone(null)} onPointerDown={drag(i)} title={`Drag to adjust ${z.label}`} />)}
        </div>
        <button className={`clip l${clipping ? ' on' : ''}${clipLo > 0.002 ? ' warn-lo' : ''}`} onClick={() => useDevelop.getState().set({ clipping: !clipping })} title={`Shadow clipping ${(clipLo * 100).toFixed(1)}% (J)`} aria-label="Toggle shadow clipping" />
        <button className={`clip r${clipping ? ' on' : ''}${clipHi > 0.002 ? ' warn-hi' : ''}`} onClick={() => useDevelop.getState().set({ clipping: !clipping })} title={`Highlight clipping ${(clipHi * 100).toFixed(1)}% (J)`} aria-label="Toggle highlight clipping" />
      </div>
      <div className="hist-info">
        {zone != null ? <span className="text-1">{ZONES[zone].label}</span> : <span>{photo ? formatExposure(photo.exif) : ''}</span>}
        <span>{photo?.isRaw ? photo.ext.toUpperCase() : ''}</span>
      </div>
    </>
  );
}
