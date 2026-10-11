/** Color page: program monitor + scopes, clip strip, primaries wheels, curves and LUTs. */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RotateCcw, Copy, ClipboardPaste, Power, FileUp, X } from 'lucide-react';
import { type Clip, clipEnd, timecode } from '@shared/project';
import { defaultGrade, isNeutral, curveTable, identityCurve, type Grade, type Wheel, type CurvePoint } from '@shared/grade';
import { useProject } from '../store/project';
import { usePlayer } from '../store/player';
import { toast } from '../store/ui';
import { ProgramMonitor } from '../components/Monitors';
import { Slider, Seg, Empty } from '../components/ui';
import { getEngine, importedLut } from '../player/engine';
import { api, cacheUrl } from '../api';

let gradeClipboard: Grade | null = null;

function useGradeTarget(): Clip | null {
  const p = useProject(s => s.project);
  const selection = useProject(s => s.selection);
  const frame = usePlayer(s => s.frame);
  const isVid = (c: Clip) => c.kind === 'media' && p.tracks.find(t => t.id === c.trackId)?.kind === 'video' && p.media.find(m => m.id === c.mediaId)?.kind !== 'audio';
  const sel = p.clips.find(c => selection.includes(c.id) && isVid(c));
  if (sel) return sel;
  // Otherwise the topmost video clip under the playhead
  const vts = p.tracks.filter(t => t.kind === 'video');
  return p.clips.filter(c => isVid(c) && frame >= c.start && frame < clipEnd(c)).sort((a, b) => vts.findIndex(t => t.id === b.trackId) - vts.findIndex(t => t.id === a.trackId))[0] ?? null;
}

export function ColorPage() {
  const c = useGradeTarget();
  const edit = useProject(s => s.edit);
  const g = c?.grade;
  const setG = (label: string, fn: (g: Grade) => void, key?: string) => {
    if (!c) return;
    edit(label, p => { const x = p.clips.find(k => k.id === c.id); if (x) fn(x.grade); }, key ? `g:${key}:${c.id}` : undefined);
  };
  return (
    <div className="page color-page">
      <div className="color-top">
        <ProgramMonitor compact showTransform={false} />
        <Scopes />
      </div>
      <ClipStrip current={c} />
      <div className="color-bottom">
        {!c || !g ? <Empty kind="timeline" title="No clip to grade" small><p>Put a video clip on the timeline, then park the playhead on it or select it.</p></Empty> : <>
          <div className="grade-bar">
            <span className="mon-title">Grading</span><span className="nm">{c.name}</span>
            <span className="grow" />
            <button className={`btn sm${g.bypass ? ' active' : ''}`} aria-pressed={g.bypass} title="Bypass this grade" onClick={() => setG(g.bypass ? 'Enable grade' : 'Bypass grade', x => { x.bypass = !x.bypass; })}><Power size={12} />Bypass</button>
            <button className="btn sm" title="Copy grade" onClick={() => { gradeClipboard = structuredClone(g); toast({ kind: 'info', title: 'Grade copied' }, 1500); }}><Copy size={12} />Copy</button>
            <button className="btn sm" title="Paste grade onto this clip" disabled={!gradeClipboard} onClick={() => setG('Paste grade', x => Object.assign(x, structuredClone(gradeClipboard!)))}><ClipboardPaste size={12} />Paste</button>
            <button className="btn sm" title="Reset grade" disabled={isNeutral(g) && !g.bypass} onClick={() => setG('Reset grade', x => Object.assign(x, defaultGrade()))}><RotateCcw size={12} />Reset</button>
          </div>
          <div className="grade-panels">
            <div className="wheels">
              {(['lift', 'gamma', 'gain', 'offset'] as const).map(k => (
                <ColorWheel key={k} label={k === 'lift' ? 'Lift' : k === 'gamma' ? 'Gamma' : k === 'gain' ? 'Gain' : 'Offset'} value={g[k]}
                  onChange={(w, done) => setG(`${k[0].toUpperCase()}${k.slice(1)}`, x => { x[k] = w; }, done ? undefined : k)} />
              ))}
            </div>
            <div className="primaries">
              <Slider label="Exposure" value={g.exposure} min={-4} max={4} step={0.01} onChange={v => setG('Exposure', x => { x.exposure = v; }, 'exp')} format={v => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`} />
              <Slider label="Temperature" value={g.temperature} min={-100} max={100} onChange={v => setG('Temperature', x => { x.temperature = v; }, 'temp')} gradient="linear-gradient(90deg,#4a7bd8,#d9d9d9,#e0a040)" />
              <Slider label="Tint" value={g.tint} min={-100} max={100} onChange={v => setG('Tint', x => { x.tint = v; }, 'tint')} gradient="linear-gradient(90deg,#4caf50,#d9d9d9,#c04fc0)" />
              <Slider label="Contrast" value={g.contrast} min={-100} max={100} onChange={v => setG('Contrast', x => { x.contrast = v; }, 'con')} />
              <Slider label="Pivot" value={g.pivot} min={0.05} max={0.95} step={0.005} defaultValue={0.435} format={v => v.toFixed(3)} onChange={v => setG('Pivot', x => { x.pivot = v; }, 'piv')} />
              <Slider label="Saturation" value={g.saturation} min={0} max={200} defaultValue={100} onChange={v => setG('Saturation', x => { x.saturation = v; }, 'sat')} format={v => `${Math.round(v)}`} />
              <LutSection g={g} setG={setG} />
            </div>
            <CurvesEditor curves={g.curves} onChange={(cv, done) => setG('Curves', x => { x.curves = cv; }, done ? undefined : 'curves')} />
          </div>
        </>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- clip strip */

function ClipStrip({ current }: { current: Clip | null }) {
  const p = useProject(s => s.project);
  const vts = p.tracks.filter(t => t.kind === 'video');
  const clips = p.clips.filter(c => c.kind === 'media' && vts.some(t => t.id === c.trackId)).sort((a, b) => a.start - b.start || vts.findIndex(t => t.id === a.trackId) - vts.findIndex(t => t.id === b.trackId));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('.cs-item.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [current?.id]);
  return (
    <div className="clip-strip" ref={ref}>
      {clips.map((c, i) => {
        const m = p.media.find(x => x.id === c.mediaId);
        const th = m?.thumbs;
        const t = c.srcIn + (c.duration / p.settings.fps / 2) * c.speed;
        const idx = th ? Math.min(th.count - 1, Math.max(0, Math.floor(t / (th.interval || 1)))) : 0;
        return (
          <button key={c.id} className={`cs-item${current?.id === c.id ? ' on' : ''}`} onClick={() => { useProject.getState().select([c.id]); usePlayer.getState().pause(); usePlayer.getState().setFrame(c.start + Math.floor(c.duration / 2)); }} title={c.name}>
            <div className="cs-thumb" style={th ? { backgroundImage: `url("${cacheUrl(th.key)}")`, backgroundSize: `${th.count * 100}% 100%`, backgroundPosition: th.count > 1 ? `${(idx / (th.count - 1)) * 100}% 0` : '0 0' } : undefined} />
            <div className="cs-meta"><span>{String(i + 1).padStart(2, '0')}</span><span className="dim">{timecode(c.start, p.settings.fps)}</span>{!isNeutral(c.grade) && <i className="cs-dot" title="Graded" />}</div>
          </button>
        );
      })}
      {!clips.length && <div className="dim small" style={{ padding: 14 }}>Clips on the timeline appear here.</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- wheel */

function ColorWheel({ label, value, onChange }: { label: string; value: Wheel; onChange(w: Wheel, done?: boolean): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const S = 132;
  useLayoutEffect(() => {
    const c = ref.current!;
    c.width = c.height = S * devicePixelRatio;
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    const R = c.width / 2;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const dx = (x - R) / R, dy = (R - y) / R, d = Math.hypot(dx, dy);
      if (d > 1) continue;
      const a = Math.atan2(dy, dx);
      // Same hue placement as wheelRgb (0° = red, counter-clockwise through green, blue)
      const k = (o: number) => 0.5 + 0.42 * d * Math.cos(a - o);
      const i = (y * c.width + x) * 4;
      img.data[i] = k(0) * 255; img.data[i + 1] = k((2 * Math.PI) / 3) * 255; img.data[i + 2] = k((4 * Math.PI) / 3) * 255;
      img.data[i + 3] = d > 0.985 ? 120 : 255;
    }
    g.putImageData(img, 0, 0);
  }, []);
  const drag = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const fine = (ev: { shiftKey: boolean; altKey: boolean }) => (ev.shiftKey || ev.altKey ? 0.25 : 1);
    let last = { x: e.clientX, y: e.clientY };
    let cur = { ...value };
    const apply = (ev: PointerEvent | React.PointerEvent, done = false) => {
      const k = fine(ev);
      let x = cur.x + ((ev.clientX - last.x) / (r.width / 2)) * k, y = cur.y - ((ev.clientY - last.y) / (r.height / 2)) * k;
      last = { x: ev.clientX, y: ev.clientY };
      const d = Math.hypot(x, y);
      if (d > 1) { x /= d; y /= d; }
      cur = { ...cur, x, y };
      onChange(cur, done);
    };
    if (e.detail === 1 && !(e.target as HTMLElement).classList.contains('puck')) {
      // Clicking the disk jumps the puck there
      cur = { ...cur, x: ((e.clientX - r.left) / r.width) * 2 - 1, y: 1 - ((e.clientY - r.top) / r.height) * 2 };
      const d = Math.hypot(cur.x, cur.y); if (d > 1) { cur.x /= d; cur.y /= d; }
      onChange(cur);
    }
    const move = (ev: PointerEvent) => apply(ev);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const vals = (() => { const a = Math.atan2(value.y, value.x), d = Math.hypot(value.x, value.y); return [0, 2, 4].map(o => d * Math.cos(a - (o * Math.PI) / 3) * (2 / 3) + value.m); })();
  return (
    <div className="wheel">
      <div className="wheel-head"><span>{label}</span><button className="icon-btn sm" title={`Reset ${label}`} onClick={() => onChange({ x: 0, y: 0, m: 0 })}><RotateCcw size={11} /></button></div>
      <div className="wheel-disk" style={{ width: S, height: S }} onPointerDown={drag} onDoubleClick={() => onChange({ ...value, x: 0, y: 0 })} role="slider" aria-label={`${label} color`} aria-valuetext={`${value.x.toFixed(2)}, ${value.y.toFixed(2)}`}>
        <canvas ref={ref} style={{ width: S, height: S }} />
        <i className="cross" />
        <i className="puck" style={{ left: `${50 + value.x * 50}%`, top: `${50 - value.y * 50}%` }} />
      </div>
      <MasterRoller value={value.m} onChange={m => onChange({ ...value, m })} />
      <div className="wheel-vals"><span className="r">{vals[0].toFixed(2)}</span><span className="g">{vals[1].toFixed(2)}</span><span className="b">{vals[2].toFixed(2)}</span></div>
    </div>
  );
}

/** Horizontal master (luma) roller under each wheel. */
function MasterRoller({ value, onChange }: { value: number; onChange(v: number): void }) {
  return <Slider label="Master" value={value} min={-1} max={1} step={0.005} onChange={onChange} format={v => `${v > 0 ? '+' : ''}${v.toFixed(2)}`} />;
}

/* ---------------------------------------------------------------- LUTs */

function LutSection({ g, setG }: { g: Grade; setG(label: string, fn: (g: Grade) => void, key?: string): void }) {
  const [, force] = useState(0);
  const loaded = g.lut ? importedLut(g.lut.path, () => force(n => n + 1)) : null;
  const pick = async () => {
    const r = await api.pickLut();
    if (!r) return;
    setG('Apply LUT', x => { x.lut = { path: r.path, name: r.name, strength: 1 }; });
  };
  return (
    <div className="lut-box">
      <div className="subhead">LUT</div>
      {g.lut ? <>
        <div className="row"><span className="nm" title={g.lut.path}>{g.lut.name}</span><span className="grow" />{loaded === null && <span className="tag warn">Missing</span>}<button className="icon-btn sm" title="Remove LUT" onClick={() => setG('Remove LUT', x => { x.lut = null; })}><X size={12} /></button></div>
        <Slider label="Strength" value={Math.round(g.lut.strength * 100)} min={0} max={100} defaultValue={100} format={v => `${Math.round(v)}%`} onChange={v => setG('LUT strength', x => { if (x.lut) x.lut.strength = v / 100; }, 'lut')} />
      </> : <button className="btn sm block" onClick={pick}><FileUp size={13} />Import .cube LUT…</button>}
    </div>
  );
}

/* -------------------------------------------------------------- curves */

type Ch = 'master' | 'r' | 'g' | 'b';
const CH_COLOR: Record<Ch, string> = { master: '#e6e6e6', r: '#ff6b6b', g: '#5ccf8e', b: '#6fa1ff' };

function CurvesEditor({ curves, onChange }: { curves: Grade['curves']; onChange(c: Grade['curves'], done?: boolean): void }) {
  const [ch, setCh] = useState<Ch>('master');
  const ref = useRef<SVGSVGElement>(null);
  const W = 260, H = 220;
  const pts = curves[ch];
  const table = curveTable(pts, 256);
  const path = Array.from(table, (v, i) => `${i ? 'L' : 'M'}${(i / 255) * W} ${H - Math.min(1, Math.max(0, v)) * H}`).join(' ');
  const set = (np: CurvePoint[], done?: boolean) => onChange({ ...curves, [ch]: np.sort((a, b) => a.x - b.x) }, done);
  const toPt = (e: { clientX: number; clientY: number }) => { const r = ref.current!.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) }; };
  const down = (e: React.PointerEvent) => {
    const p = toPt(e);
    let i = pts.findIndex(q => Math.hypot((q.x - p.x) * W, (q.y - p.y) * H) < 9);
    let np = pts.map(q => ({ ...q }));
    if (i < 0) { np.push(p); np.sort((a, b) => a.x - b.x); i = np.findIndex(q => q.x === p.x && q.y === p.y); set(np); }
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const q = toPt(ev);
      const lo = i > 0 ? np[i - 1].x + 0.01 : 0, hi = i < np.length - 1 ? np[i + 1].x - 0.01 : 1;
      // End points stay at the edges
      const x = i === 0 && np[0].x === 0 ? 0 : i === np.length - 1 && np[i].x === 1 ? 1 : Math.min(hi, Math.max(lo, q.x));
      np = np.map((k, j) => (j === i ? { x, y: q.y } : k));
      set(np);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const remove = (e: React.MouseEvent) => {
    e.preventDefault();
    const p = toPt(e);
    const i = pts.findIndex(q => Math.hypot((q.x - p.x) * W, (q.y - p.y) * H) < 9);
    if (i > 0 && i < pts.length - 1) set(pts.filter((_, j) => j !== i), true);
  };
  return (
    <div className="curves">
      <div className="row">
        <span className="subhead" style={{ margin: 0, flex: 1 }}>Curves</span>
        <Seg value={ch} options={(['master', 'r', 'g', 'b'] as Ch[]).map(c => ({ value: c, label: c === 'master' ? 'Y' : c.toUpperCase() }))} onChange={setCh} />
        <button className="icon-btn sm" title="Reset this curve" onClick={() => set(identityCurve(), true)}><RotateCcw size={11} /></button>
      </div>
      <svg ref={ref} className="curve-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} onPointerDown={down} onContextMenu={remove} onDoubleClick={remove}>
        {[1, 2, 3].map(i => <g key={i}><line x1={(i * W) / 4} y1={0} x2={(i * W) / 4} y2={H} /><line x1={0} y1={(i * H) / 4} x2={W} y2={(i * H) / 4} /></g>)}
        <line className="diag" x1={0} y1={H} x2={W} y2={0} />
        {(['master', 'r', 'g', 'b'] as Ch[]).filter(k => k !== ch && curves[k].length > 2).map(k => <path key={k} d={Array.from(curveTable(curves[k], 64), (v, i) => `${i ? 'L' : 'M'}${(i / 63) * W} ${H - v * H}`).join(' ')} stroke={CH_COLOR[k]} opacity={0.3} fill="none" />)}
        <path d={path} stroke={CH_COLOR[ch]} strokeWidth={1.6} fill="none" />
        {pts.map((q, i) => <circle key={i} cx={q.x * W} cy={H - q.y * H} r={4.5} fill="#16171b" stroke={CH_COLOR[ch]} strokeWidth={1.5} />)}
      </svg>
      <p className="dim small">Click to add a point, drag to shape, right-click to remove.</p>
    </div>
  );
}

/* --------------------------------------------------------------- scopes */

type ScopeKind = 'waveform' | 'parade' | 'vector' | 'histogram';

export function Scopes() {
  const [kind, setKind] = useState<ScopeKind>(() => (localStorage.getItem('psp.scope') as ScopeKind) || 'parade');
  const out = useRef<HTMLCanvasElement>(null);
  useEffect(() => { try { localStorage.setItem('psp.scope', kind); } catch { /* ignore */ } }, [kind]);
  useEffect(() => {
    const eng = getEngine();
    const sample = document.createElement('canvas');
    const SW = 240, SH = 135;
    sample.width = SW; sample.height = SH;
    const sg = sample.getContext('2d', { willReadFrequently: true })!;
    let last = 0, raf = 0, dirty = true;
    const off = eng.onRendered(() => { dirty = true; });
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      if (!dirty || now - last < 110 || !out.current) return;
      last = now; dirty = false;
      sg.drawImage(eng.canvas, 0, 0, SW, SH);
      const px = sg.getImageData(0, 0, SW, SH).data;
      renderScope(out.current, kind, px, SW, SH);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); off(); };
  }, [kind]);
  return (
    <div className="scopes">
      <div className="monitor-head"><span className="mon-title">Scopes</span><span className="grow" />
        <Seg value={kind} options={[{ value: 'waveform', label: 'Waveform' }, { value: 'parade', label: 'Parade' }, { value: 'vector', label: 'Vector' }, { value: 'histogram', label: 'Histogram' }]} onChange={setKind} />
      </div>
      <div className="scope-view"><canvas ref={out} data-testid="scope" /></div>
    </div>
  );
}

function renderScope(c: HTMLCanvasElement, kind: ScopeKind, px: Uint8ClampedArray, SW: number, SH: number) {
  const W = Math.max(200, c.clientWidth * devicePixelRatio), H = Math.max(120, c.clientHeight * devicePixelRatio);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a0b0d'; g.fillRect(0, 0, W, H);
  const img = g.createImageData(W, H);
  const d = img.data;
  const add = (x: number, y: number, r: number, gg: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = ((y | 0) * W + (x | 0)) * 4;
    d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + gg); d[i + 2] = Math.min(255, d[i + 2] + b); d[i + 3] = 255;
  };
  const pad = 6 * devicePixelRatio, ih = H - pad * 2;
  if (kind === 'waveform' || kind === 'parade') {
    const k = Math.max(6, Math.round(2400 / (SH * 3)));
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4, r = px[i], gg = px[i + 1], b = px[i + 2];
      if (kind === 'waveform') {
        const Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        add((x / SW) * W, pad + ih - (Y / 255) * ih, k, k + 2, k);
      } else {
        const w3 = W / 3;
        add((x / SW) * w3, pad + ih - (r / 255) * ih, k + 6, 0, 0);
        add(w3 + (x / SW) * w3, pad + ih - (gg / 255) * ih, 0, k + 6, 0);
        add(2 * w3 + (x / SW) * w3, pad + ih - (b / 255) * ih, 0, 0, k + 8);
      }
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.font = `${9 * devicePixelRatio}px Inter Variable, sans-serif`;
    for (const v of [0, 25, 50, 75, 100]) { const y = pad + ih - (v / 100) * ih; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(String(v), 3, y - 2); }
    if (kind === 'parade') for (const x of [W / 3, (2 * W) / 3]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    return;
  }
  if (kind === 'vector') {
    const R = Math.min(W, H) / 2 - pad, cx = W / 2, cy = H / 2;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
      const Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const cb = (b - Y) / 1.8556, cr = (r - Y) / 1.5748;
      add(cx + cb * 2 * R, cy - cr * 2 * R, 18 + r * 30, 18 + gg * 30, 18 + b * 30);
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    // 75% color targets
    const targets: [string, number, number, number][] = [['R', 0.75, 0, 0], ['Yl', 0.75, 0.75, 0], ['G', 0, 0.75, 0], ['Cy', 0, 0.75, 0.75], ['B', 0, 0, 0.75], ['Mg', 0.75, 0, 0.75]];
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = `${9 * devicePixelRatio}px Inter Variable, sans-serif`;
    for (const [n, r, gg, b] of targets) {
      const Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const x = cx + ((b - Y) / 1.8556) * 2 * R, y = cy - ((r - Y) / 1.5748) * 2 * R;
      g.strokeRect(x - 4, y - 4, 8, 8); g.fillText(n, x + 6, y + 3);
    }
    // Skin tone line
    g.strokeStyle = 'rgba(227,169,92,0.35)';
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos((-123 * Math.PI) / 180) * R, cy + Math.sin((-123 * Math.PI) / 180) * R); g.stroke();
    return;
  }
  // Histogram
  const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < px.length; i += 4) { bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++; }
  let max = 1;
  for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
  g.globalCompositeOperation = 'lighter';
  ['rgba(255,80,80,0.55)', 'rgba(80,220,120,0.55)', 'rgba(90,140,255,0.6)'].forEach((col, ci) => {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - pad - Math.min(1, Math.sqrt(bins[ci][i] / max)) * ih);
    g.lineTo(W, H); g.fill();
  });
  g.globalCompositeOperation = 'source-over';
}

