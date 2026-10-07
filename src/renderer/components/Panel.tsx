import React, { useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '../store/app';

/** Collapsible, resizable side panel. Width and open state persist in settings. */
export function SidePanel({ side, children, header }: { side: 'left' | 'right'; children: ReactNode; header?: ReactNode }) {
  const open = useApp(s => (side === 'left' ? s.leftOpen : s.rightOpen));
  const width = useApp(s => (side === 'left' ? s.leftWidth : s.rightWidth));
  const setPanel = useApp(s => s.setPanel);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  if (!open) {
    return (
      <div className="collapsed-rail" style={{ [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--line)' } as any}
        onClick={() => setPanel(side === 'left' ? { leftOpen: true } : { rightOpen: true })} title="Show panel" role="button" aria-label={`Show ${side} panel`}>
        {side === 'left' ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </div>
    );
  }

  const startResize = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const x0 = e.clientX, w0 = width;
    const move = (ev: PointerEvent) => {
      const d = side === 'left' ? ev.clientX - x0 : x0 - ev.clientX;
      const w = Math.max(200, Math.min(520, w0 + d));
      setPanel(side === 'left' ? { leftWidth: w } : { rightWidth: w });
    };
    const up = () => { setDragging(false); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <aside ref={ref} className={side === 'left' ? 'panel-left' : 'panel-right'} style={{ width }}>
      {header}
      <div className="panel-scroll">{children}</div>
      <div className={`resizer${dragging ? ' dragging' : ''}`} onPointerDown={startResize}
        onDoubleClick={() => setPanel(side === 'left' ? { leftOpen: false } : { rightOpen: false })} title="Drag to resize · double-click to hide" />
    </aside>
  );
}
