import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Star, Flag } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { Thumb } from './Thumb';
import { openMenu } from './ui';
import { photoMenu } from '../library/menus';

export function Filmstrip({ hidden }: { hidden: boolean }) {
  const photos = useLibrary(s => s.photos);
  const activeId = useLibrary(s => s.activeId);
  const selection = useLibrary(s => s.selection);
  const select = useLibrary(s => s.select);
  const setPanel = useApp(s => s.setPanel);
  const track = useRef<HTMLDivElement>(null);
  const active = photos.find(p => p.id === activeId);

  useEffect(() => {
    const el = track.current?.querySelector('.film-cell.active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeId]);

  const idx = photos.findIndex(p => p.id === activeId);
  return (
    <div className={`filmstrip${hidden ? ' collapsed' : ''}`}>
      <div className="filmstrip-bar">
        <button className="icon-btn sm" onClick={() => setPanel({ filmstripOpen: hidden })} aria-label={hidden ? 'Show filmstrip' : 'Hide filmstrip'}>{hidden ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
        <span className="grow">
          {photos.length} photo{photos.length === 1 ? '' : 's'}
          {selection.length > 1 && <> · {selection.length} selected</>}
          {active && <> · <span className="text-1">{idx + 1}/{photos.length}</span> · {active.filename}{active.copyName ? ` (${active.copyName})` : ''}</>}
        </span>
      </div>
      {!hidden && (
        <div className="filmstrip-track" ref={track} onWheel={e => { if (track.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) track.current.scrollLeft += e.deltaY; }}>
          {photos.map(p => (
            <div key={p.id} className={`film-cell${p.id === activeId ? ' active' : selection.includes(p.id) ? ' selected' : ''}${p.flag === 'reject' ? ' rejected' : ''}`}
              onClick={e => select(p.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single')}
              onContextMenu={e => { if (!selection.includes(p.id)) select(p.id); openMenu(e, photoMenu(p)); }}
              title={p.filename}>
              <Thumb photo={p} />
              {p.rating > 0 && <span className="mini-stars">{'★'.repeat(p.rating)}</span>}
              {p.flag === 'pick' && <Flag size={9} className="film-flag" fill="currentColor" />}
              {p.label !== 'none' && <span className="film-label" style={{ background: `var(--label-${p.label})` }} />}
              {p.hasEdits && <span className="film-edited" title="Edited" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
