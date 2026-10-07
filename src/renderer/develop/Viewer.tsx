import React, { useEffect, useRef, useState } from 'react';
import { ZoomIn, Columns2, Rows2, SplitSquareHorizontal, Eye, TriangleAlert } from 'lucide-react';
import { host, useView } from '../engine/host';
import { useDevelop, type CompareMode } from '../store/develop';
import { useLibrary } from '../store/library';
import { pickWhiteBalance } from '../analysis/autoTone';
import { CropOverlay } from './CropOverlay';
import { ThumbError } from '../components/Thumb';
import { media } from '../api';
import type { Photo } from '@shared/types';

/** The main editing canvas: GPU render, zoom/pan, before/after, and tool overlays. */
export function Viewer({ photo, children, hud = true }: { photo: Photo | null; children?: React.ReactNode; hud?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapping = useView(s => s.mapping);
  const ready = useView(s => s.ready);
  const tool = useDevelop(s => s.tool);
  const zoom = useDevelop(s => s.zoom);
  const compare = useDevelop(s => s.compare);
  const loading = useDevelop(s => s.loadingSource);
  const err = useDevelop(s => s.sourceError);
  const [spaceDown, setSpaceDown] = useState(false);
  const [hover, setHover] = useState<[number, number] | null>(null);

  useEffect(() => {
    const el = ref.current!;
    host().attach(el);
    return () => host().detach(el);
  }, []);

  useEffect(() => {
    const d = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement)?.closest('input,textarea')) { setSpaceDown(true); } };
    const u = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', d); window.addEventListener('keyup', u);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); };
  }, []);

  const toUv = (clientX: number, clientY: number): [number, number] | null => {
    const m = useView.getState().mapping, el = ref.current;
    if (!m || !el) return null;
    const r = el.getBoundingClientRect();
    return [(clientX - r.left - m.ox) / m.dw, (clientY - r.top - m.oy) / m.dh];
  };

  const zoomAt = (clientX: number, clientY: number, z: number | 'fit') => {
    const dev = useDevelop.getState(), m = useView.getState().mapping, el = ref.current;
    if (!m || !el) return;
    if (z === 'fit') { dev.set({ zoom: 'fit', center: [0.5, 0.5] }); return; }
    const r = el.getBoundingClientRect();
    const uv = toUv(clientX, clientY)!;
    const x = clientX - r.left, y = clientY - r.top;
    const dw = m.outW * z, dh = m.outH * z;
    const ox = x - uv[0] * dw, oy = y - uv[1] * dh;
    const cw = m.side ? m.cssW / 2 : m.cssW;
    dev.set({ zoom: z, center: [clamp01((cw / 2 - ox) / dw), clamp01((m.cssH / 2 - oy) / dh)] });
  };

  const onWheel = (e: React.WheelEvent) => {
    const m = useView.getState().mapping;
    if (!m) return;
    const dev = useDevelop.getState();
    if (!(e.ctrlKey || e.metaKey) && typeof dev.zoom === 'number' && Math.abs(e.deltaX) + Math.abs(e.deltaY) > 0 && !e.altKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
      // Trackpad two-finger scroll pans when zoomed in
      dev.set({ center: [clamp01(dev.center[0] + e.deltaX / m.dw), clamp01(dev.center[1] + e.deltaY / m.dh)] });
      return;
    }
    const cur = typeof dev.zoom === 'number' ? dev.zoom : m.zoom;
    const nz = Math.max(m.fitZoom * 0.5, Math.min(8, cur * Math.exp(-e.deltaY * 0.0022)));
    if (nz <= m.fitZoom * 1.001 && e.deltaY > 0) { dev.set({ zoom: 'fit', center: [0.5, 0.5] }); return; }
    zoomAt(e.clientX, e.clientY, nz);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !mapping) return;
    const dev = useDevelop.getState();
    if (tool === 'wb' && !spaceDown) {
      const uv = toUv(e.clientX, e.clientY);
      if (uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1) pickWhiteBalance(uv);
      return;
    }
    if (tool !== 'none' && !spaceDown) return; // tool overlays handle their own input
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const c0 = dev.center;
    const zoomed = typeof dev.zoom === 'number';
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      const m = useView.getState().mapping!;
      if (zoomed) useDevelop.getState().set({ center: [clamp01(c0[0] - dx / m.dw), clamp01(c0[1] - dy / m.dh)] });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      if (moved) return;
      // Click toggles fit ↔ 100%
      if (zoomed) zoomAt(ev.clientX, ev.clientY, 'fit');
      else zoomAt(ev.clientX, ev.clientY, 1);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const cursor = spaceDown ? 'grab' : tool === 'wb' ? 'crosshair' : tool !== 'none' ? 'default' : typeof zoom === 'number' ? 'grab' : 'zoom-in';
  const showPlaceholder = photo && (!ready || loading) && !err && photo.thumbState !== 'error';

  return (
    <div className="viewer" ref={ref} tabIndex={-1} onWheel={onWheel} onPointerDown={onPointerDown} style={{ cursor }}
      onPointerMove={e => tool === 'wb' && setHover(toUv(e.clientX, e.clientY))} onPointerLeave={() => setHover(null)}>
      {showPlaceholder && <div className="preview-placeholder"><img src={media.preview(photo!.id)} alt="" /></div>}
      {loading && <div className="viewer-loading"><div className="spinner lg" /><span>{photo?.isRaw ? 'Decoding RAW…' : 'Loading…'}</span></div>}
      {err && photo && (
        <div className="viewer-error">
          {photo.thumbState === 'error' ? <ThumbError photo={photo} large /> : (
            <div className="cell-error large" role="alert">
              <TriangleAlert size={30} />
              <div className="t">{photo.isRaw ? 'Unable to process this RAW file.' : err.message}</div>
              <div className="muted small selectable">{err.detail}</div>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn sm" onClick={() => { host().photo = null; host().setPhoto(photo); }}>Retry</button>
                <button className="btn sm ghost" onClick={() => useLibrary.getState().navigate(1)}>Skip</button>
              </div>
            </div>
          )}
        </div>
      )}
      {!photo && <div className="viewer-loading"><span className="muted">Select a photo in the filmstrip to start editing.</span></div>}
      <div className="viewer-overlay">
        {tool === 'crop' && mapping && <CropOverlay />}
        {(compare === 'split-v' || compare === 'split-h') && mapping && <SplitHandle mode={compare} />}
        {children}
        {compare !== 'off' && mapping && <BeforeAfterLabels mode={compare} />}
        {tool === 'wb' && hover && <div className="wb-hint">Click a neutral gray or white area</div>}
      </div>
      {hud && photo && !err && <ViewerHud />}
    </div>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function SplitHandle({ mode }: { mode: CompareMode }) {
  const split = useDevelop(s => s.split);
  const m = useView(s => s.mapping)!;
  const vertical = mode === 'split-v';
  const pos = split * (vertical ? m.cssW : m.cssH);
  const start = (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = el.parentElement!.getBoundingClientRect();
    const move = (ev: PointerEvent) => useDevelop.getState().set({ split: clamp01(vertical ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height) });
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return <div className={`split-handle interactive ${vertical ? 'v' : 'h'}`} style={vertical ? { left: pos } : { top: pos }} onPointerDown={start} role="separator" aria-label="Before/after divider"><span /></div>;
}

function BeforeAfterLabels({ mode }: { mode: CompareMode }) {
  if (mode === 'before') return <div className="viewer-badge" style={{ left: 12 }}>Before</div>;
  if (mode === 'side') return <><div className="viewer-badge" style={{ left: 12 }}>Before</div><div className="viewer-badge" style={{ left: 'calc(50% + 12px)' }}>After</div></>;
  if (mode === 'split-v') return <><div className="viewer-badge" style={{ left: 12 }}>Before</div><div className="viewer-badge" style={{ right: 12 }}>After</div></>;
  return <><div className="viewer-badge" style={{ left: 12 }}>Before</div><div className="viewer-badge" style={{ left: 12, top: 'auto', bottom: 60 }}>After</div></>;
}

export function ViewerHud() {
  const zoom = useDevelop(s => s.zoom);
  const compare = useDevelop(s => s.compare);
  const set = useDevelop(s => s.set);
  const setCompare = useDevelop(s => s.setCompare);
  const clipping = useDevelop(s => s.clipping);
  const m = useView(s => s.mapping);
  const pct = m ? Math.round(m.zoom * 100) : 0;
  const modes: { id: CompareMode; icon: React.ReactNode; title: string }[] = [
    { id: 'before', icon: <Eye size={14} />, title: 'Show before (\\)' },
    { id: 'split-v', icon: <SplitSquareHorizontal size={14} />, title: 'Split before/after' },
    { id: 'split-h', icon: <Rows2 size={14} />, title: 'Split top/bottom' },
    { id: 'side', icon: <Columns2 size={14} />, title: 'Side by side' },
  ];
  return (
    <div className="viewer-hud" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div className="hud-pill">
        <button className={`btn sm ghost${zoom === 'fit' ? ' active' : ''}`} onClick={() => set({ zoom: 'fit', center: [0.5, 0.5] })}>Fit</button>
        <button className={`btn sm ghost${zoom === 'fill' ? ' active' : ''}`} onClick={() => set({ zoom: 'fill', center: [0.5, 0.5] })}>Fill</button>
        <button className={`btn sm ghost${zoom === 1 ? ' active' : ''}`} onClick={() => set({ zoom: 1 })}>100%</button>
        <button className={`btn sm ghost${zoom === 2 ? ' active' : ''}`} onClick={() => set({ zoom: 2 })}>200%</button>
        <span className="lbl"><ZoomIn size={11} /> {pct}%</span>
      </div>
      <div className="hud-pill">
        <button className={`btn sm ghost ba-toggle${compare !== 'off' ? ' active' : ''}`} onClick={() => setCompare(compare === 'off' ? 'before' : 'off')} title="Before / After (\)">
          {compare === 'off' ? 'After' : 'Before'}<span className="sep">/</span>{compare === 'off' ? 'Before' : 'After'}
        </button>
        {modes.map(md => <button key={md.id} className={`icon-btn sm${compare === md.id ? ' active' : ''}`} title={md.title} onClick={() => setCompare(compare === md.id ? 'off' : md.id)}>{md.icon}</button>)}
      </div>
      <div className="hud-pill">
        <button className={`btn sm ghost${clipping ? ' active' : ''}`} onClick={() => set({ clipping: !clipping })} title="Show clipped highlights (red) and shadows (blue) (J)">Clipping</button>
      </div>
    </div>
  );
}
