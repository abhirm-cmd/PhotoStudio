import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Flag, X, Heart, Sparkles, Layers, SlidersHorizontal } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { Thumb } from '../components/Thumb';
import { Stars, LABEL_COLORS, openMenu } from '../components/ui';
import { photoMenu } from './menus';
import { setGridColumns, setRating, goWorkspace } from '../services/actions';
import type { Photo } from '@shared/types';

const GAP = 10;
const META_H = 27;

/** Virtualized thumbnail grid: only visible rows are mounted, so 50k-photo catalogs scroll smoothly. */
export function Grid() {
  const photos = useLibrary(s => s.photos);
  const selection = useLibrary(s => s.selection);
  const activeId = useLibrary(s => s.activeId);
  const size = useLibrary(s => s.thumbSize);
  const select = useLibrary(s => s.select);
  const setView = useLibrary(s => s.setView);
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 });

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setBox(b => ({ ...b, w: el.clientWidth - 28, h: el.clientHeight })));
    ro.observe(el);
    setBox(b => ({ ...b, w: el.clientWidth - 28, h: el.clientHeight }));
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((box.w + GAP) / (size + GAP)));
  const cellW = (box.w - GAP * (cols - 1)) / cols;
  const rowH = cellW + META_H + GAP;
  const rows = Math.ceil(photos.length / cols);
  useEffect(() => setGridColumns(cols), [cols]);

  const first = Math.max(0, Math.floor(box.top / rowH) - 2);
  const last = Math.min(rows, Math.ceil((box.top + box.h) / rowH) + 2);
  const visible = photos.slice(first * cols, last * cols);

  // Keep the active photo in view when navigating with the keyboard.
  useEffect(() => {
    const el = wrap.current;
    if (!el || activeId == null) return;
    const i = photos.findIndex(p => p.id === activeId);
    if (i < 0) return;
    const y = Math.floor(i / cols) * rowH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight + 14;
  }, [activeId, cols, rowH]);

  const onClick = useCallback((e: React.MouseEvent, p: Photo) => {
    select(p.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single');
  }, [select]);

  return (
    <div className="grid-wrap" ref={wrap} tabIndex={0} aria-label="Photo grid" onScroll={e => setBox(b => ({ ...b, top: (e.target as HTMLElement).scrollTop }))}
      onMouseDown={e => { if (e.target === e.currentTarget) useLibrary.getState().setSelection([], null); }}>
      <div style={{ height: rows * rowH, position: 'relative' }}>
        {visible.map((p, k) => {
          const i = first * cols + k;
          const r = Math.floor(i / cols), c = i % cols;
          return (
            <Cell key={p.id} photo={p} style={{ position: 'absolute', left: c * (cellW + GAP), top: r * rowH, width: cellW }}
              selected={selection.includes(p.id)} active={p.id === activeId} onClick={onClick}
              onDouble={() => { select(p.id); setView('loupe'); }} />
          );
        })}
      </div>
    </div>
  );
}

const Cell = React.memo(function Cell({ photo: p, style, selected, active, onClick, onDouble }: { photo: Photo; style: React.CSSProperties; selected: boolean; active: boolean; onClick(e: React.MouseEvent, p: Photo): void; onDouble(): void }) {
  return (
    <div className={`cell${selected ? ' selected' : ''}${active ? ' active' : ''}${p.flag === 'reject' ? ' rejected' : ''}`} style={style}
      onClick={e => onClick(e, p)} onDoubleClick={onDouble}
      onContextMenu={e => { const lib = useLibrary.getState(); if (!lib.selection.includes(p.id)) lib.select(p.id); openMenu(e, photoMenu(p)); }}
      draggable onDragStart={e => {
        const lib = useLibrary.getState();
        const ids = lib.selection.includes(p.id) ? lib.selection : [p.id];
        e.dataTransfer.setData('application/x-lumora-photos', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      role="gridcell" aria-selected={selected} aria-label={`${p.filename}, ${p.rating} stars${p.flag !== 'none' ? ', ' + p.flag : ''}`}>
      <div className="cell-img">
        <Thumb photo={p} />
        <div className="cell-badges">
          {p.isRaw && <span className="badge">{p.ext.toUpperCase()}</span>}
          {p.masterId != null && <span className="badge" title="Virtual copy"><Layers size={9} /></span>}
          {p.hasEdits && <span className="badge accent" title="Edited"><SlidersHorizontal size={9} /></span>}
          {p.aiEnhanced && <span className="badge ai" title="AI enhanced"><Sparkles size={9} /></span>}
        </div>
        <div className="cell-flag">
          {p.flag === 'pick' && <span className="badge" title="Pick"><Flag size={9} fill="currentColor" /></span>}
          {p.flag === 'reject' && <span className="badge danger" title="Rejected"><X size={9} /></span>}
          {p.favorite && <span className="badge fav" title="Favorite"><Heart size={9} fill="currentColor" /></span>}
        </div>
      </div>
      <div className="cell-meta">
        {p.label !== 'none' && <span className="cell-label" style={{ background: LABEL_COLORS[p.label] }} />}
        <span className="name" title={p.path}>{p.copyName ? `${p.filename} · ${p.copyName}` : p.filename}</span>
        <Stars value={p.rating} size={10} onChange={v => setRating(v, [p.id])} />
      </div>
    </div>
  );
});

export function openInDevelop(id: number) {
  useLibrary.getState().setActive(id);
  goWorkspace('develop');
  useApp.getState();
}
