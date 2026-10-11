/** Two resizable panes. The split position is remembered per id. */
import React, { useRef, useState, type ReactNode } from 'react';

export function Split({ id, dir, initial, min = 0.1, max = 0.9, children }: { id: string; dir: 'row' | 'col'; initial: number; min?: number; max?: number; children: [ReactNode, ReactNode] }) {
  const [f, setF] = useState(() => { const v = Number(localStorage.getItem(`psp.split.${id}`)); return v > 0 ? v : initial; });
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const down = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDrag(true);
    const r = ref.current!.getBoundingClientRect();
    let v = f;
    const move = (ev: PointerEvent) => { v = Math.min(max, Math.max(min, dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height)); setF(v); };
    const up = () => { setDrag(false); try { localStorage.setItem(`psp.split.${id}`, String(v)); } catch { /* ignore */ } el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <div className={`split split-${dir}`} ref={ref}>
      <div className="split-a" style={{ flexBasis: `${f * 100}%` }}>{children[0]}</div>
      <div className={`split-handle${drag ? ' dragging' : ''}`} onPointerDown={down} onDoubleClick={() => setF(initial)} />
      <div className="split-b">{children[1]}</div>
    </div>
  );
}
