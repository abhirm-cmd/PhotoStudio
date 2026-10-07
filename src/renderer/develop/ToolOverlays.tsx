import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useView, host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { cloneEdit, defaultEdit, HSL_CHANNELS, type Vec2 } from '@shared/edit';
import { solveGuided } from '../analysis/upright';
import { HSL_CENTERS, convertMatrix, SPACES, linearSrgbToOklab, oklabToLch } from '@shared/color';
import { makeSpline } from '../engine/curves';

/* --------------------------------------------------------- guided upright */

/** While drawing guides the photo is shown without perspective correction so guides follow the real lines. */
export function GuidesOverlay() {
  const m = useView(s => s.mapping)!;
  const guides = useDevelop(s => s.edit.transform.guides);
  const [draft, setDraft] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dev = useDevelop.getState();
    const e = cloneEdit(dev.edit);
    e.transform = { ...defaultEdit().transform, guides: e.transform.guides };
    e.crop = { ...e.crop, x: 0, y: 0, w: 1, h: 1, angle: 0 };
    dev.setPreview(e, 'Guided Upright');
    return () => useDevelop.getState().setPreview(null);
  }, []);

  const src = host().renderer?.source;
  const fw = src ? (useDevelop.getState().edit.crop.orientation % 180 ? src.height : src.width) : 1;
  const fh = src ? (useDevelop.getState().edit.crop.orientation % 180 ? src.width : src.height) : 1;
  const hd = 0.5 * Math.hypot(fw, fh);
  const toNorm = (u: number, v: number): Vec2 => [(u * fw - fw / 2) / hd, (v * fh - fh / 2) / hd];
  const fromNorm = (p: Vec2): [number, number] => [m.ox + ((p[0] * hd + fw / 2) / fw) * m.dw, m.oy + ((p[1] * hd + fh / 2) / fh) * m.dh];
  const uvAt = (ev: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [(ev.clientX - r.left - m.ox) / m.dw, (ev.clientY - r.top - m.oy) / m.dh];
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const a = uvAt(e);
    let cur = { a, b: a };
    setDraft(cur);
    const move = (ev: PointerEvent) => { cur = { a, b: uvAt(ev) }; setDraft(cur); };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      setDraft(null);
      const len = Math.hypot((cur.b[0] - a[0]) * m.dw, (cur.b[1] - a[1]) * m.dh);
      if (len < 24) return;
      const next = [...useDevelop.getState().edit.transform.guides, { a: toNorm(...cur.a), b: toNorm(...cur.b) }].slice(-4);
      solveGuided(next);
      // keep the untransformed preview while drawing
      const pe = cloneEdit(useDevelop.getState().edit);
      pe.transform = { ...defaultEdit().transform, guides: next };
      pe.crop = { ...pe.crop, x: 0, y: 0, w: 1, h: 1, angle: 0 };
      useDevelop.getState().setPreview(pe, 'Guided Upright');
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const removeGuide = (i: number) => {
    const next = guides.filter((_, j) => j !== i);
    if (next.length) solveGuided(next);
    else useDevelop.getState().setEdit(e => { e.transform = { ...defaultEdit().transform }; }, 'Upright: Off');
    const pe = cloneEdit(useDevelop.getState().edit);
    pe.transform = { ...defaultEdit().transform, guides: next };
    pe.crop = { ...pe.crop, x: 0, y: 0, w: 1, h: 1, angle: 0 };
    useDevelop.getState().setPreview(pe, 'Guided Upright');
  };

  return (
    <div className="tool-layer interactive" ref={ref} onPointerDown={down} style={{ cursor: 'crosshair' }}>
      <svg>
        {guides.map((g, i) => { const a = fromNorm(g.a), b = fromNorm(g.b); return <g key={i}><line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="guide-line" /><circle cx={a[0]} cy={a[1]} r={4} className="guide-end" /><circle cx={b[0]} cy={b[1]} r={4} className="guide-end" /></g>; })}
        {draft && <line x1={m.ox + draft.a[0] * m.dw} y1={m.oy + draft.a[1] * m.dh} x2={m.ox + draft.b[0] * m.dw} y2={m.oy + draft.b[1] * m.dh} className="guide-line draft" />}
      </svg>
      {guides.map((g, i) => { const a = fromNorm(g.a), b = fromNorm(g.b); return <button key={i} className="guide-x icon-btn sm" style={{ left: (a[0] + b[0]) / 2, top: (a[1] + b[1]) / 2 }} onPointerDown={e => e.stopPropagation()} onClick={() => removeGuide(i)} aria-label="Remove guide"><X size={10} /></button>; })}
      <div className="tool-hint">Guided Upright · {guides.length}/4 guides · <button className="link" onPointerDown={e => e.stopPropagation()} onClick={() => useDevelop.getState().set({ tool: 'none' })}>Done</button></div>
    </div>
  );
}

/* ------------------------------------------------------ targeted adjustment */

const toSrgb = convertMatrix(SPACES.rec2020, SPACES.srgb);

function sampleAt(uv: [number, number]): { hue: number; chroma: number; L: number } | null {
  const h = host(), r = h.renderer;
  if (!r || !h.out) return null;
  const s = r.readSmall(h.out, 256);
  const x = Math.round(uv[0] * (s.w - 1)), y = Math.round(uv[1] * (s.h - 1));
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return null;
  let R = 0, G = 0, B = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= s.w || yy >= s.h) continue;
    const i = (yy * s.w + xx) * 4;
    R += s.data[i]; G += s.data[i + 1]; B += s.data[i + 2]; n++;
  }
  R /= n; G /= n; B /= n;
  const rgb: [number, number, number] = [toSrgb[0] * R + toSrgb[1] * G + toSrgb[2] * B, toSrgb[3] * R + toSrgb[4] * G + toSrgb[5] * B, toSrgb[6] * R + toSrgb[7] * G + toSrgb[8] * B];
  const [L, C, hue] = oklabToLch(linearSrgbToOklab(rgb.map(v => Math.max(0, v)) as any));
  return { hue, chroma: C, L };
}

/** Weights of the 8 HSL channels for a hue (linear between neighbouring centers). */
export function channelWeights(hue: number): number[] {
  const w = new Array(8).fill(0);
  for (let i = 0; i < 8; i++) {
    const a = HSL_CENTERS[i], b = HSL_CENTERS[(i + 1) % 8] + (i === 7 ? 360 : 0);
    let h = hue;
    if (i === 7 && h < a) h += 360;
    if (h >= a && h <= b) { const t = (h - a) / (b - a); w[i] = 1 - t; w[(i + 1) % 8] = t; return w; }
  }
  // hue below the first center: between magenta (335) and red (25)
  const t = (hue + 360 - HSL_CENTERS[7]) / (HSL_CENTERS[0] + 360 - HSL_CENTERS[7]);
  w[7] = 1 - t; w[0] = t;
  return w;
}

export function TargetedOverlay() {
  const m = useView(s => s.mapping)!;
  const mode = useDevelop(s => s.targetedMode);
  const [hint, setHint] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const uvAt = (ev: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [(ev.clientX - r.left - m.ox) / m.dw, (ev.clientY - r.top - m.oy) / m.dh];
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const smp = sampleAt(uvAt(e));
    if (!smp) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const dev = useDevelop.getState();
    const base = cloneEdit(dev.edit);
    const weights = channelWeights(smp.hue);
    const x = Math.min(0.98, Math.max(0.02, Math.pow(Math.max(smp.L, 0), 1) ));
    const move = (ev: PointerEvent) => {
      const d = (y0 - ev.clientY) / 2; // px up = positive
      useDevelop.getState().setEdit(ed => {
        if (mode === 'curve') {
          const pts = base.curve.rgb.filter(p => Math.abs(p.x - x) > 0.04 || p.x === 0 || p.x === 1);
          const f = makeSpline(base.curve.rgb);
          const y = Math.min(1, Math.max(0, f(x) + d / 400));
          const list = [...pts, { x, y }].sort((a, b) => a.x - b.x);
          ed.curve.rgb = list;
        } else {
          HSL_CHANNELS.forEach((ch, i) => {
            if (weights[i] < 0.01) return;
            const k = mode as 'hue' | 'saturation' | 'luminance';
            ed.hsl[ch][k] = Math.round(Math.max(-100, Math.min(100, base.hsl[ch][k] + d * weights[i] * (k === 'hue' ? 0.5 : 1))));
          });
        }
      });
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); useDevelop.getState().commit(mode === 'curve' ? 'Tone Curve (targeted)' : `Color Mixer ${mode} (targeted)`); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const hover = (e: React.PointerEvent) => {
    const smp = sampleAt(uvAt(e));
    if (!smp) return setHint(null);
    if (mode === 'curve') return setHint(`Tone ${Math.round(smp.L * 100)}%`);
    const w = channelWeights(smp.hue);
    setHint(HSL_CHANNELS.filter((_, i) => w[i] > 0.15).map(c => c[0].toUpperCase() + c.slice(1)).join(' + ') + (smp.chroma < 0.02 ? ' (nearly neutral)' : ''));
  };
  return (
    <div className="tool-layer interactive" ref={ref} onPointerDown={down} onPointerMove={hover} style={{ cursor: 'ns-resize' }}>
      <div className="tool-hint">Targeted {mode === 'curve' ? 'Tone Curve' : mode} · drag up/down{hint ? ` · ${hint}` : ''} · <button className="link" onPointerDown={e => e.stopPropagation()} onClick={() => useDevelop.getState().set({ tool: 'none' })}>Done</button></div>
    </div>
  );
}
