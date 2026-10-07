import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { useLibrary } from '../store/library';
import { Thumb, ThumbError } from '../components/Thumb';
import { Stars, FlagMark, LABEL_COLORS, openMenu } from '../components/ui';
import { photoMenu } from './menus';
import { setRating, goWorkspace } from '../services/actions';
import { formatExposure } from './format';
import type { Photo } from '@shared/types';

/** Single-photo view for culling. Click toggles between fit and a 1:1 view of the preview, which can be dragged. */
export function Loupe() {
  const photos = useLibrary(s => s.photos);
  const activeId = useLibrary(s => s.activeId);
  const p = photos.find(x => x.id === activeId) ?? photos[0];
  const [zoom, setZoom] = useState(false);
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setZoom(false); setPan({ x: 0.5, y: 0.5 }); }, [activeId]);
  if (!p) return null;

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = box.current!;
    const r = el.getBoundingClientRect();
    if (!zoom) { setPan({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); setZoom(true); return; }
    let moved = false;
    const x0 = e.clientX, y0 = e.clientY, p0 = pan;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      moved = moved || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3;
      setPan({ x: Math.min(1, Math.max(0, p0.x - (ev.clientX - x0) / r.width)), y: Math.min(1, Math.max(0, p0.y - (ev.clientY - y0) / r.height)) });
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); if (!moved) setZoom(false); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className="loupe" ref={box} onPointerDown={down} onContextMenu={e => openMenu(e, photoMenu(p))} style={{ cursor: zoom ? 'grab' : 'zoom-in' }}>
      {p.thumbState === 'error' ? <ThumbError photo={p} large /> : (
        <div className={`loupe-img${zoom ? ' zoomed' : ''}`} style={zoom ? { transformOrigin: `${pan.x * 100}% ${pan.y * 100}%` } : undefined}>
          <Thumb key={p.id} photo={p} size="preview" />
        </div>
      )}
      <LoupeInfo photo={p} />
      <button className="loupe-nav l icon-btn" onPointerDown={e => e.stopPropagation()} onClick={() => useLibrary.getState().navigate(-1)} aria-label="Previous"><ChevronLeft size={22} /></button>
      <button className="loupe-nav r icon-btn" onPointerDown={e => e.stopPropagation()} onClick={() => useLibrary.getState().navigate(1)} aria-label="Next"><ChevronRight size={22} /></button>
    </div>
  );
}

function LoupeInfo({ photo: p }: { photo: Photo }) {
  return (
    <div className="loupe-info" onPointerDown={e => e.stopPropagation()}>
      <div className="row">
        {p.label !== 'none' && <span className="cell-label" style={{ background: LABEL_COLORS[p.label] }} />}
        <strong className="text-0">{p.filename}</strong>{p.copyName && <span className="dim">· {p.copyName}</span>}
        <FlagMark flag={p.flag} size={14} />
      </div>
      <div className="dim small">{[p.exif.model, formatExposure(p.exif)].filter(Boolean).join(' · ')}</div>
      <div className="row mt8">
        <Stars value={p.rating} size={14} onChange={v => setRating(v, [p.id])} />
        <button className="btn sm" onClick={() => goWorkspace('develop')}><SlidersHorizontal size={12} />Develop</button>
      </div>
    </div>
  );
}

export function Survey() {
  const photos = useLibrary(s => s.photos);
  const selection = useLibrary(s => s.selection);
  const activeId = useLibrary(s => s.activeId);
  const setSelection = useLibrary(s => s.setSelection);
  const ids = selection.length > 1 ? selection : photos.slice(Math.max(0, photos.findIndex(p => p.id === activeId)), Math.max(0, photos.findIndex(p => p.id === activeId)) + 4).map(p => p.id);
  const items = ids.map(id => photos.find(p => p.id === id)).filter(Boolean) as Photo[];
  const n = items.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  if (!n) return null;
  return (
    <div className="survey" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {items.map(p => (
        <div key={p.id} className={`survey-cell${p.id === activeId ? ' active' : ''}${p.flag === 'reject' ? ' rejected' : ''}`}
          onClick={() => useLibrary.setState({ activeId: p.id })} onContextMenu={e => openMenu(e, photoMenu(p))}>
          <div className="survey-img"><Thumb photo={p} size="preview" /></div>
          <div className="survey-meta">
            <span className="name">{p.filename}</span>
            <FlagMark flag={p.flag} />
            <Stars value={p.rating} onChange={v => setRating(v, [p.id])} />
            {selection.length > 1 && <button className="icon-btn sm" title="Remove from survey" onClick={e => { e.stopPropagation(); setSelection(selection.filter(x => x !== p.id), activeId === p.id ? selection.find(x => x !== p.id) ?? null : activeId); }}><X size={12} /></button>}
          </div>
        </div>
      ))}
    </div>
  );
}
