import React, { useEffect, useRef, useState } from 'react';
import { useView, host } from '../engine/host';
import { useDevelop } from '../store/develop';
import { outToSrc, srcToOut } from '../engine/geometry';
import { updateComponent, viewGeometry, addAiComponent, outUvToFrameUv, pendingObjectOp, resetObjectOp } from './maskOps';
import type { BrushDab, MaskComponent, Vec2 } from '@shared/edit';

/** On-image handles and painting for the selected mask component. */
export function MaskOverlay() {
  const m = useView(s => s.mapping);
  const tool = useDevelop(s => s.tool);
  const maskId = useDevelop(s => s.selectedMask);
  const compId = useDevelop(s => s.selectedComponent);
  const mask = useDevelop(s => s.edit.masks.find(x => x.id === s.selectedMask) ?? null);
  const brush = useDevelop(s => s.brush);
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return;
      const dev = useDevelop.getState();
      if (e.key === '[' || e.key === ']') { dev.set({ brush: { ...dev.brush, size: Math.max(4, Math.min(600, dev.brush.size * (e.key === ']' ? 1.15 : 1 / 1.15))) } }); e.preventDefault(); }
      if (e.key === 'o' || e.key === 'O') { dev.set({ maskOverlay: !dev.maskOverlay }); e.preventDefault(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // Re-render handles when geometry changes (crop/transform) — mapping covers zoom/pan
  useEffect(() => useDevelop.subscribe((s, p) => { if (s.edit.crop !== p.edit.crop || s.edit.transform !== p.edit.transform) bump(x => x + 1); }), []);

  if (!m || !maskId || !mask) return null;
  const vg = viewGeometry();
  if (!vg) return null;
  const { g } = vg;
  const comp = mask.components.find(c => c.id === compId) ?? null;

  const toScreen = (src: Vec2): [number, number] => { const o = srcToOut(g, src); return [m.ox + o[0] * m.dw, m.oy + o[1] * m.dh]; };
  const evUv = (ev: { clientX: number; clientY: number }): Vec2 => { const r = ref.current!.getBoundingClientRect(); return [(ev.clientX - r.left - m.ox) / m.dw, (ev.clientY - r.top - m.oy) / m.dh]; };
  const evSrc = (ev: { clientX: number; clientY: number }): Vec2 => outToSrc(g, evUv(ev));
  const cssPerSrcPx = m.dw / g.outW;

  const capture = (e: React.PointerEvent, move: (ev: PointerEvent) => void, up?: (ev: PointerEvent) => void) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => move(ev);
    const u = (ev: PointerEvent) => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', u); up?.(ev); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', u);
  };
  const commit = (label: string) => useDevelop.getState().commit(label);

  /* ------------------------------------------------------ tool layers */
  const layer = (() => {
    if (tool === 'brush' && comp?.type === 'brush') {
      const long = Math.max(vg.srcW, vg.srcH);
      const down = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const dev = useDevelop.getState();
        const erase = dev.brush.erase || e.altKey;
        const rNorm = (dev.brush.size / 2) / cssPerSrcPx / long;
        const spacing = Math.max(1.5, dev.brush.size * 0.12);
        let last: [number, number] | null = null;
        const add = (ev: { clientX: number; clientY: number }) => {
          const pt: [number, number] = [ev.clientX, ev.clientY];
          const pts: [number, number][] = [];
          if (!last) pts.push(pt);
          else {
            const d = Math.hypot(pt[0] - last[0], pt[1] - last[1]);
            if (d < spacing) return;
            const n = Math.floor(d / spacing);
            for (let i = 1; i <= n; i++) pts.push([last[0] + ((pt[0] - last[0]) * i) / n, last[1] + ((pt[1] - last[1]) * i) / n]);
          }
          last = pts[pts.length - 1];
          const dabs: BrushDab[] = pts.map(p => { const s = evSrc({ clientX: p[0], clientY: p[1] }); return { x: s[0], y: s[1], r: rNorm, flow: dev.brush.flow / 100, feather: dev.brush.feather / 100, erase }; });
          appendDabs(maskId, comp.id, dabs);
        };
        add(e);
        capture(e, ev => { add(ev); setCursor(evClient(ev)); }, () => commit(erase ? 'Brush: Erase' : 'Brush'));
      };
      return <div className="tool-layer interactive" ref={ref} onPointerDown={down} onPointerMove={e => setCursor(evClient(e))} onPointerLeave={() => setCursor(null)} style={{ cursor: 'none' }} />;
    }
    if (tool === 'color-pick' && comp?.type === 'color') {
      const click = (e: React.PointerEvent) => {
        e.stopPropagation();
        const r = host().renderer;
        if (!r) return;
        const dev = useDevelop.getState();
        const s = r.readSceneSmall(dev.edit, host().renderContext(dev.edit), 384);
        const uv = evUv(e);
        const x = Math.round(uv[0] * (s.w - 1)), y = Math.round(uv[1] * (s.h - 1));
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
        let R = 0, G = 0, B = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(s.w - 1, Math.max(0, x + dx)), yy = Math.min(s.h - 1, Math.max(0, y + dy)); const i = (yy * s.w + xx) * 4; R += s.data[i]; G += s.data[i + 1]; B += s.data[i + 2]; n++; }
        const sample: [number, number, number] = [R / n, G / n, B / n];
        updateComponent(maskId, comp.id, c => { const cc = c as any; cc.samples = e.shiftKey ? [...cc.samples, sample].slice(-8) : [sample]; }, 'Color Range Sample');
      };
      return <div className="tool-layer interactive" ref={ref} onPointerDown={click} style={{ cursor: 'crosshair' }}><div className="tool-hint">Click a color to select it · Shift-click to add more</div></div>;
    }
    if (tool === 'lum-pick' && comp?.type === 'luminance') {
      const click = (e: React.PointerEvent) => {
        e.stopPropagation();
        const r = host().renderer;
        if (!r) return;
        const dev = useDevelop.getState();
        const s = r.readSceneSmall(dev.edit, host().renderContext(dev.edit), 384);
        const uv = evUv(e);
        const x = Math.round(uv[0] * (s.w - 1)), y = Math.round(uv[1] * (s.h - 1));
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
        const i = (y * s.w + x) * 4;
        const l = 0.2627 * s.data[i] + 0.678 * s.data[i + 1] + 0.0593 * s.data[i + 2];
        const L = Math.min(1, Math.max(0, Math.pow(Math.max(l, 0) / (1 + l), 1 / 2.2) * 1.3));
        updateComponent(maskId, comp.id, c => { const cc = c as any; cc.min = Math.max(0, L - 0.12); cc.max = Math.min(1, L + 0.12); }, 'Luminance Range');
        useDevelop.getState().set({ tool: 'none' });
      };
      return <div className="tool-layer interactive" ref={ref} onPointerDown={click} style={{ cursor: 'crosshair' }}><div className="tool-hint">Click a tone to select similar brightness</div></div>;
    }
    if (tool === 'object') {
      const down = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const a = evUv(e);
        let b = a;
        setBox([a[0], a[1], 0, 0]);
        capture(e, ev => { b = evUv(ev); setBox([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]); }, async () => {
          setBox(null);
          useDevelop.getState().set({ tool: 'none' });
          if (Math.abs(b[0] - a[0]) * m.dw < 12 || Math.abs(b[1] - a[1]) * m.dh < 12) return;
          // Box corners → analysis frame (bounding box of the mapped corners)
          const corners = [[a[0], a[1]], [b[0], a[1]], [a[0], b[1]], [b[0], b[1]]].map(p => outUvToFrameUv(p as Vec2)!).filter(Boolean);
          const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
          const fb: [number, number, number, number] = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), 0, 0];
          fb[2] = Math.min(1, Math.max(...xs)) - fb[0]; fb[3] = Math.min(1, Math.max(...ys)) - fb[1];
          const op = pendingObjectOp;
          resetObjectOp();
          const ok = await addAiComponent(maskId, 'object', op, fb);
          if (!ok && !useDevelop.getState().edit.masks.find(x => x.id === maskId)?.components.length) useDevelop.getState().setEdit(ed => { ed.masks = ed.masks.filter(x => x.id !== maskId); });
        });
      };
      return (
        <div className="tool-layer interactive" ref={ref} onPointerDown={down} style={{ cursor: 'crosshair' }}>
          {box && <div className="object-box" style={{ left: m.ox + box[0] * m.dw, top: m.oy + box[1] * m.dh, width: box[2] * m.dw, height: box[3] * m.dh }} />}
          <div className="tool-hint">Drag a box around the object to select it</div>
        </div>
      );
    }
    if ((tool === 'linear' || tool === 'radial') && comp && (comp.type === 'linear' || comp.type === 'radial')) {
      // Drag on the photo to (re)draw the gradient
      const down = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const a = evSrc(e);
        capture(e, ev => {
          const b = evSrc(ev);
          updateComponent(maskId, comp.id, c => {
            if (c.type === 'linear') { c.a = a; c.b = b; }
            if (c.type === 'radial') { c.cx = a[0]; c.cy = a[1]; c.rx = Math.max(0.01, Math.abs(b[0] - a[0])); c.ry = Math.max(0.01, Math.abs(b[1] - a[1]) * (ev.shiftKey ? 1 : 1)); if (ev.shiftKey) { const r = Math.max(c.rx * vg.srcW, c.ry * vg.srcH); c.rx = r / vg.srcW; c.ry = r / vg.srcH; } }
          });
        }, () => { commit(comp.type === 'linear' ? 'Linear Gradient' : 'Radial Gradient'); useDevelop.getState().set({ tool: 'none' }); });
      };
      return <div className="tool-layer interactive" ref={ref} onPointerDown={down} style={{ cursor: 'crosshair' }}><div className="tool-hint">Drag on the photo to draw the {comp.type} gradient{comp.type === 'radial' ? ' (Shift for a circle)' : ''}</div></div>;
    }
    return <div className="tool-layer" ref={ref} />;
  })();

  /* -------------------------------------------------- component handles */
  let handles: React.ReactNode = null;
  if (comp?.type === 'linear' && tool !== 'linear') handles = <LinearHandles comp={comp} maskId={maskId} toScreen={toScreen} evSrc={evSrc} capture={capture} commit={commit} />;
  if (comp?.type === 'radial' && tool !== 'radial') handles = <RadialHandles comp={comp} maskId={maskId} toScreen={toScreen} evSrc={evSrc} capture={capture} commit={commit} srcW={vg.srcW} srcH={vg.srcH} />;

  return (
    <>
      {layer}
      {handles}
      {tool === 'brush' && cursor && ref.current && (() => { const r = ref.current.getBoundingClientRect(); return <div className={`brush-cursor${brush.erase ? ' erase' : ''}`} style={{ left: cursor[0] - r.left, top: cursor[1] - r.top, width: brush.size, height: brush.size }}><div style={{ inset: `${(brush.size * (1 - brush.feather / 100)) / 2 > 0 ? (brush.size * (brush.feather / 100)) / 2 : 0}px` }} /></div>; })()}
    </>
  );
}

const evClient = (e: { clientX: number; clientY: number }): [number, number] => [e.clientX, e.clientY];

/** Fast append without deep-cloning the whole edit for each dab. */
function appendDabs(maskId: string, compId: string, dabs: BrushDab[]) {
  const s = useDevelop.getState();
  const edit = { ...s.edit, masks: s.edit.masks.map(m => (m.id !== maskId ? m : { ...m, components: m.components.map(c => (c.id !== compId || c.type !== 'brush' ? c : { ...c, dabs: [...c.dabs, ...dabs] })) })) };
  useDevelop.setState({ edit });
}

type HP = { maskId: string; toScreen(p: Vec2): [number, number]; evSrc(e: { clientX: number; clientY: number }): Vec2; capture(e: React.PointerEvent, m: (ev: PointerEvent) => void, u?: (ev: PointerEvent) => void): void; commit(l: string): void };

function LinearHandles({ comp, maskId, toScreen, evSrc, capture, commit }: HP & { comp: Extract<MaskComponent, { type: 'linear' }> }) {
  const a = comp.a, b = comp.b;
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const perp: Vec2 = [-d[1], d[0]];
  const len = Math.hypot(perp[0], perp[1]) || 1;
  const L = 3 / len; // extend lines well past the image
  const line = (p: Vec2) => [toScreen([p[0] - perp[0] * L, p[1] - perp[1] * L]), toScreen([p[0] + perp[0] * L, p[1] + perp[1] * L])];
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [la, lb, lm] = [line(a), line(b), line(mid)];
  const drag = (which: 'a' | 'b' | 'mid') => (e: React.PointerEvent) => {
    const start = evSrc(e);
    const a0 = comp.a, b0 = comp.b;
    capture(e, ev => {
      const p = evSrc(ev);
      const dx = p[0] - start[0], dy = p[1] - start[1];
      updateComponent(maskId, comp.id, c => {
        if (c.type !== 'linear') return;
        if (which === 'mid') { c.a = [a0[0] + dx, a0[1] + dy]; c.b = [b0[0] + dx, b0[1] + dy]; }
        else if (which === 'a') c.a = [a0[0] + dx, a0[1] + dy];
        else c.b = [b0[0] + dx, b0[1] + dy];
      });
    }, () => commit('Linear Gradient'));
  };
  const pa = toScreen(a), pb = toScreen(b), pm = toScreen(mid);
  return (
    <>
      <svg className="mask-svg">
        <line x1={la[0][0]} y1={la[0][1]} x2={la[1][0]} y2={la[1][1]} className="mh-line" />
        <line x1={lm[0][0]} y1={lm[0][1]} x2={lm[1][0]} y2={lm[1][1]} className="mh-line dashed" />
        <line x1={lb[0][0]} y1={lb[0][1]} x2={lb[1][0]} y2={lb[1][1]} className="mh-line faint" />
      </svg>
      <div className="mh-pin interactive" style={{ left: pa[0], top: pa[1] }} onPointerDown={drag('a')} title="Full effect" />
      <div className="mh-pin center interactive" style={{ left: pm[0], top: pm[1] }} onPointerDown={drag('mid')} title="Move" />
      <div className="mh-pin interactive" style={{ left: pb[0], top: pb[1] }} onPointerDown={drag('b')} title="No effect" />
    </>
  );
}

function RadialHandles({ comp, maskId, toScreen, evSrc, capture, commit, srcW, srcH }: HP & { comp: Extract<MaskComponent, { type: 'radial' }>; srcW: number; srcH: number }) {
  const ang = (comp.angle * Math.PI) / 180;
  // Ellipse point at parameter t in source pixel space
  const at = (t: number, k = 1): Vec2 => {
    const ex = Math.cos(t) * comp.rx * srcW * k, ey = Math.sin(t) * comp.ry * srcH * k;
    const x = Math.cos(ang) * ex - Math.sin(ang) * ey, y = Math.sin(ang) * ex + Math.cos(ang) * ey;
    return [comp.cx + x / srcW, comp.cy + y / srcH];
  };
  const poly = (k: number) => Array.from({ length: 73 }, (_, i) => toScreen(at((i / 72) * Math.PI * 2, k))).map(p => p.join(',')).join(' ');
  const c = toScreen([comp.cx, comp.cy]);
  const right = toScreen(at(0)), bottom = toScreen(at(Math.PI / 2)), left = toScreen(at(Math.PI)), top = toScreen(at(-Math.PI / 2));
  const rot = toScreen(at(-Math.PI / 2, 1.25));
  const move = (e: React.PointerEvent) => {
    const s0 = evSrc(e), c0 = [comp.cx, comp.cy];
    capture(e, ev => { const p = evSrc(ev); updateComponent(maskId, comp.id, x => { if (x.type === 'radial') { x.cx = c0[0] + p[0] - s0[0]; x.cy = c0[1] + p[1] - s0[1]; } }); }, () => commit('Radial Gradient'));
  };
  const resize = (axis: 'x' | 'y') => (e: React.PointerEvent) => {
    capture(e, ev => {
      const p = evSrc(ev);
      const dx = (p[0] - comp.cx) * srcW, dy = (p[1] - comp.cy) * srcH;
      // project onto the ellipse's local axis
      const lx = Math.cos(-ang) * dx - Math.sin(-ang) * dy, ly = Math.sin(-ang) * dx + Math.cos(-ang) * dy;
      updateComponent(maskId, comp.id, x => {
        if (x.type !== 'radial') return;
        if (axis === 'x') x.rx = Math.max(0.005, Math.abs(lx) / srcW); else x.ry = Math.max(0.005, Math.abs(ly) / srcH);
        if (ev.shiftKey) { const r = axis === 'x' ? Math.abs(lx) : Math.abs(ly); x.rx = r / srcW; x.ry = r / srcH; }
      });
    }, () => commit('Radial Gradient'));
  };
  const rotate = (e: React.PointerEvent) => {
    capture(e, ev => {
      const p = evSrc(ev);
      const a = (Math.atan2((p[1] - comp.cy) * srcH, (p[0] - comp.cx) * srcW) * 180) / Math.PI + 90;
      updateComponent(maskId, comp.id, x => { if (x.type === 'radial') x.angle = Math.round(ev.shiftKey ? Math.round(a / 15) * 15 : a); });
    }, () => commit('Radial Gradient'));
  };
  return (
    <>
      <svg className="mask-svg">
        <polyline points={poly(1)} className="mh-line" fill="none" />
        <polyline points={poly(Math.max(0.02, 1 - comp.feather / 100))} className="mh-line faint" fill="none" />
        <line x1={top[0]} y1={top[1]} x2={rot[0]} y2={rot[1]} className="mh-line faint" />
      </svg>
      <div className="mh-pin center interactive" style={{ left: c[0], top: c[1] }} onPointerDown={move} title="Move" />
      {[right, left].map((p, i) => <div key={`x${i}`} className="mh-pin sq interactive" style={{ left: p[0], top: p[1] }} onPointerDown={resize('x')} />)}
      {[top, bottom].map((p, i) => <div key={`y${i}`} className="mh-pin sq interactive" style={{ left: p[0], top: p[1] }} onPointerDown={resize('y')} />)}
      <div className="mh-pin rot interactive" style={{ left: rot[0], top: rot[1] }} onPointerDown={rotate} title="Rotate" />
    </>
  );
}
