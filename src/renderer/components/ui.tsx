import React, { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { ChevronDown, Star, Flag, X, CheckCircle2, AlertTriangle, Info, RotateCcw } from 'lucide-react';
import type { ColorLabel, Flag as FlagT } from '@shared/types';

/* ------------------------------------------------------------------ Slider */

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange(v: number): void;
  onCommit?(v: number): void;
  format?(v: number): string;
  parse?(s: string): number;
  gradient?: string;
  disabled?: boolean;
  title?: string;
  /** Show fill from the default value */
  bipolar?: boolean;
}

export function Slider({ label, value, min, max, step = 1, defaultValue = 0, onChange, onCommit, format, parse, gradient, disabled, title, bipolar }: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const valRef = useRef(value);
  valRef.current = value;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const quant = (v: number) => Math.round(v / step) * step;
  const fmt = format ?? ((v: number) => (step < 1 ? (v > 0 && min < 0 ? '+' : '') + v.toFixed(step < 0.1 ? 2 : 1) : (v > 0 && min < 0 ? '+' : '') + Math.round(v)));
  const modified = Math.abs(value - defaultValue) > step / 2;

  const start = useCallback((e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const el = track.current!;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    let lastX = e.clientX;
    let v = clamp(quant(min + ((e.clientX - rect.left) / rect.width) * (max - min)));
    onChange(v);
    setDrag(true);
    const move = (ev: PointerEvent) => {
      // Holding Alt/Shift gives fine control (10x slower)
      const fine = ev.altKey || ev.shiftKey;
      if (fine) v = clamp(v + ((ev.clientX - lastX) / rect.width) * (max - min) * 0.1);
      else v = clamp(min + ((ev.clientX - rect.left) / rect.width) * (max - min));
      lastX = ev.clientX;
      onChange(quant(v));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(false);
      onCommit?.(valRef.current);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, [min, max, step, disabled, onChange, onCommit]);

  const key = (e: React.KeyboardEvent) => {
    let d = 0;
    const big = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step * big;
    else if (e.key === 'Home') { onChange(min); onCommit?.(min); e.preventDefault(); return; }
    else if (e.key === 'End') { onChange(max); onCommit?.(max); e.preventDefault(); return; }
    else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') { onChange(defaultValue); onCommit?.(defaultValue); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    const nv = clamp(quant(value + d));
    onChange(nv);
    onCommit?.(nv);
  };

  const reset = () => { onChange(defaultValue); onCommit?.(defaultValue); };
  const commitText = () => {
    if (text == null) return;
    const n = parse ? parse(text) : parseFloat(text.replace(/[^0-9.+-]/g, ''));
    setText(null);
    if (Number.isFinite(n)) { const v = clamp(n); onChange(v); onCommit?.(v); }
  };
  const zero = bipolar !== false && min < defaultValue && max > defaultValue ? pct(defaultValue) : min < 0 && max > 0 ? pct(0) : null;
  const fillFrom = zero ?? 0;
  const p = pct(value);

  return (
    <div className={`slider${drag ? ' dragging' : ''}`} title={title} style={{ opacity: disabled ? 0.45 : 1 }}>
      <div className="slider-top">
        <span className={`slider-label${modified ? ' mod' : ''}`} onDoubleClick={reset}>{label}</span>
        <input
          className={`slider-value${modified ? ' mod' : ''}`}
          aria-label={`${label} value`}
          value={text ?? fmt(value)}
          onChange={e => setText(e.target.value)}
          onFocus={e => { setText(fmt(value)); requestAnimationFrame(() => e.target.select()); }}
          onBlur={commitText}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); } }}
          disabled={disabled}
        />
      </div>
      <div
        ref={track}
        className={`slider-track${gradient ? ' gradient' : ''}`}
        style={gradient ? ({ ['--track-bg' as any]: gradient }) : undefined}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={fmt(value)}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={start}
        onKeyDown={key}
        onDoubleClick={reset}
      >
        {zero !== null && <div className="slider-zero" style={{ left: `${zero}%` }} />}
        {!gradient && <div className="slider-fill" style={{ left: `${Math.min(fillFrom, p)}%`, width: `${Math.abs(p - fillFrom)}%` }} />}
        <div className="slider-thumb" style={{ left: `${p}%` }} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Section */

const sectionState: Record<string, boolean> = (() => { try { return JSON.parse(localStorage.getItem('photostudio.sections') ?? '{}'); } catch { return {}; } })();

export function Section({ id, title, children, defaultOpen = true, actions, badge, onReset, resetDisabled }: { id: string; title: ReactNode; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; badge?: ReactNode; onReset?: () => void; resetDisabled?: boolean }) {
  const [open, setOpen] = useState(sectionState[id] ?? defaultOpen);
  const toggle = () => { const v = !open; setOpen(v); sectionState[id] = v; try { localStorage.setItem('photostudio.sections', JSON.stringify(sectionState)); } catch { /* ignore */ } };
  return (
    <section className={`section${open ? '' : ' closed'}`} aria-label={typeof title === 'string' ? title : id}>
      <div className="section-head" onClick={toggle} role="button" aria-expanded={open} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <ChevronDown size={13} className="chev" />
        <span>{title}</span>
        {badge}
        <span className="grow" />
        <span className="head-actions" onClick={e => e.stopPropagation()}>
          {actions}
          {onReset && <button className="icon-btn sm" title="Reset section" onClick={onReset} disabled={resetDisabled}><RotateCcw size={12} /></button>}
        </span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/* --------------------------------------------------------------- Segmented */

export function Seg<T extends string>({ value, options, onChange, full }: { value: T; options: { value: NoInfer<T>; label: ReactNode; title?: string }[]; onChange(v: NoInfer<T>): void; full?: boolean }) {
  return (
    <div className={`seg${full ? ' full' : ''}`} role="radiogroup">
      {options.map(o => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} title={o.title} role="radio" aria-checked={o.value === value}>{o.label}</button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- Stars */

export function Stars({ value, onChange, size = 11 }: { value: number; onChange?(v: number): void; size?: number }) {
  return (
    <span className="stars" aria-label={`${value} stars`}>
      {[1, 2, 3, 4, 5].map(i => (
        onChange
          ? <button key={i} onClick={e => { e.stopPropagation(); onChange(value === i ? 0 : i); }} aria-label={`${i} star`}><Star size={size} className={i <= value ? 'on' : ''} fill={i <= value ? 'currentColor' : 'none'} /></button>
          : <Star key={i} size={size} className={i <= value ? 'on' : ''} fill={i <= value ? 'currentColor' : 'none'} />
      ))}
    </span>
  );
}

export const LABEL_COLORS: Record<ColorLabel, string> = { none: 'transparent', red: 'var(--label-red)', yellow: 'var(--label-yellow)', green: 'var(--label-green)', blue: 'var(--label-blue)', purple: 'var(--label-purple)' };

export function FlagMark({ flag, size = 12 }: { flag: FlagT; size?: number }) {
  if (flag === 'none') return null;
  return flag === 'pick'
    ? <span className="badge" style={{ color: 'var(--text-0)' }} title="Pick"><Flag size={size - 3} fill="currentColor" /></span>
    : <span className="badge" style={{ color: 'var(--danger)' }} title="Rejected"><X size={size - 3} /></span>;
}

/* ------------------------------------------------------------------- Modal */

export function Modal({ title, children, footer, onClose, wide, icon }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose(): void; wide?: boolean; icon?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">{icon}<h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Context menu */

export interface MenuItem { label?: string; icon?: ReactNode; shortcut?: string; danger?: boolean; onClick?: () => void; sep?: boolean; disabled?: boolean }
let openMenuFn: ((x: number, y: number, items: MenuItem[]) => void) | null = null;
export const openMenu = (e: { clientX: number; clientY: number; preventDefault?(): void }, items: MenuItem[]) => { e.preventDefault?.(); openMenuFn?.(e.clientX, e.clientY, items); };

export function MenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => { openMenuFn = (x, y, items) => setM({ x, y, items }); return () => { openMenuFn = null; }; }, []);
  useEffect(() => {
    if (!m) return;
    const close = () => setM(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', k); };
  }, [m]);
  if (!m) return null;
  const x = Math.min(m.x, window.innerWidth - 220), y = Math.min(m.y, window.innerHeight - m.items.length * 30 - 20);
  return (
    <div className="menu" style={{ left: x, top: y }} onMouseDown={e => e.stopPropagation()} role="menu">
      {m.items.map((it, i) => it.sep ? <div key={i} className="menu-sep" /> : (
        <div key={i} role="menuitem" className={`menu-item${it.danger ? ' danger' : ''}`} style={{ opacity: it.disabled ? 0.4 : 1 }} onClick={() => { if (it.disabled) return; setM(null); it.onClick?.(); }}>
          {it.icon}{it.label}{it.shortcut && <span className="kbd">{it.shortcut}</span>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Toasts */

import { useApp } from '../store/app';
export function Toasts() {
  const toasts = useApp(s => s.toasts);
  const dismiss = useApp(s => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <AlertTriangle size={16} /> : <Info size={16} />}
          <div className="grow">
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
            {t.action && <button className="btn sm mt8" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          </div>
          <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- Progress */

export const Progress = ({ value, total, indeterminate }: { value?: number; total?: number; indeterminate?: boolean }) => (
  <div className={`progress${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-valuenow={value} aria-valuemax={total}>
    <div style={{ width: `${total ? Math.min(100, ((value ?? 0) / total) * 100) : 0}%` }} />
  </div>
);

/* --------------------------------------------------------------- Empty state */

export function EmptyArt({ kind }: { kind: 'library' | 'masks' | 'presets' | 'reference' | 'search' | 'compare' | 'export' }) {
  // Subtle line illustrations built from photographic motifs (frames, aperture, light).
  const stroke = 'var(--line-3)', accent = 'var(--accent)';
  return (
    <svg className="art" viewBox="0 0 132 96" fill="none" aria-hidden>
      {kind === 'library' && (<>
        <rect x="30" y="18" width="70" height="52" rx="5" stroke={stroke} strokeWidth="1.5" transform="rotate(-8 65 44)" />
        <rect x="34" y="22" width="70" height="52" rx="5" fill="var(--bg-2)" stroke={stroke} strokeWidth="1.5" transform="rotate(4 69 48)" />
        <path d="M44 66l14-16 10 10 8-7 14 13" stroke={accent} strokeWidth="1.6" strokeLinejoin="round" transform="rotate(4 69 48)" />
        <circle cx="84" cy="38" r="5" stroke={accent} strokeWidth="1.6" transform="rotate(4 69 48)" />
      </>)}
      {kind === 'masks' && (<>
        <rect x="28" y="16" width="76" height="60" rx="6" stroke={stroke} strokeWidth="1.5" />
        <circle cx="66" cy="46" r="18" stroke={accent} strokeWidth="1.6" strokeDasharray="3 3" />
        <path d="M40 70c10-14 20-20 30-20" stroke={stroke} strokeWidth="1.5" />
      </>)}
      {kind === 'presets' && (<>
        {[0, 1, 2].map(i => <rect key={i} x={26 + i * 28} y={26 + (i % 2) * 6} width="24" height="34" rx="4" stroke={i === 1 ? accent : stroke} strokeWidth="1.5" fill={i === 1 ? 'var(--accent-soft)' : 'none'} />)}
      </>)}
      {kind === 'reference' && (<>
        <rect x="14" y="24" width="40" height="48" rx="4" stroke={stroke} strokeWidth="1.5" />
        <rect x="78" y="24" width="40" height="48" rx="4" stroke={accent} strokeWidth="1.6" />
        <path d="M58 48h16m0 0l-5-5m5 5l-5 5" stroke={accent} strokeWidth="1.6" strokeLinecap="round" />
        {[0, 1, 2, 3].map(i => <circle key={i} cx={22 + i * 8} cy="62" r="2.6" fill={['#d8a26a', '#7b8fb0', '#c56f5a', '#e7d3b0'][i]} />)}
      </>)}
      {kind === 'search' && (<><circle cx="58" cy="44" r="18" stroke={stroke} strokeWidth="1.5" /><path d="M71 57l14 14" stroke={accent} strokeWidth="1.8" strokeLinecap="round" /></>)}
      {kind === 'compare' && (<><rect x="20" y="22" width="44" height="52" rx="4" stroke={stroke} strokeWidth="1.5" /><rect x="68" y="22" width="44" height="52" rx="4" stroke={accent} strokeWidth="1.6" /></>)}
      {kind === 'export' && (<><rect x="34" y="20" width="64" height="48" rx="5" stroke={stroke} strokeWidth="1.5" /><path d="M66 34v28m0 0l-8-8m8 8l8-8" stroke={accent} strokeWidth="1.6" strokeLinecap="round" /></>)}
    </svg>
  );
}

export function Empty({ kind, title, children, small }: { kind: Parameters<typeof EmptyArt>[0]['kind']; title: string; children?: ReactNode; small?: boolean }) {
  return (
    <div className={`empty${small ? ' small' : ''}`}>
      <EmptyArt kind={kind} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function Kbd({ combo }: { combo?: string }) {
  if (!combo) return null;
  const mac = (window as any).photostudio?.platform === 'darwin';
  return <span className="kbd">{combo.replace('Mod', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace('Alt', mac ? '⌥' : 'Alt').replace(/\+/g, mac ? '' : '+')}</span>;
}

/* ------------------------------------------------------- Prompt / confirm */
// window.prompt is not available in Electron, so text input dialogs are rendered here.

interface PromptReq { title: string; label?: string; value: string; confirm?: boolean; danger?: boolean; okLabel?: string; body?: string; resolve(v: string | null): void }
let pushPrompt: ((r: PromptReq) => void) | null = null;

export function promptText(title: string, value = '', opts: { label?: string; okLabel?: string } = {}): Promise<string | null> {
  return new Promise(resolve => { if (!pushPrompt) return resolve(null); pushPrompt({ title, value, ...opts, resolve }); });
}
export function confirmDialog(title: string, body: string, opts: { okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise(resolve => { if (!pushPrompt) return resolve(false); pushPrompt({ title, body, value: '', confirm: true, ...opts, resolve: v => resolve(v !== null) }); });
}

export function PromptHost() {
  const [req, setReq] = useState<PromptReq | null>(null);
  const [val, setVal] = useState('');
  useEffect(() => { pushPrompt = r => { setReq(r); setVal(r.value); }; return () => { pushPrompt = null; }; }, []);
  if (!req) return null;
  const done = (v: string | null) => { req.resolve(v); setReq(null); };
  return (
    <Modal title={req.title} onClose={() => done(null)} footer={<>
      <button className="btn ghost" onClick={() => done(null)}>Cancel</button>
      <button className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => done(req.confirm ? '' : val.trim() || null)} disabled={!req.confirm && !val.trim()}>{req.okLabel ?? 'OK'}</button>
    </>}>
      {req.body && <p className="muted" style={{ marginTop: 0, lineHeight: 1.55 }}>{req.body}</p>}
      {!req.confirm && (
        <div className="field">
          {req.label && <label>{req.label}</label>}
          <input className="input" autoFocus value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && val.trim()) done(val.trim()); }} />
        </div>
      )}
    </Modal>
  );
}
