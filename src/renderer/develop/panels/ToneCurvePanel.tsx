import React, { useMemo, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { useDevelop } from '../../store/develop';
import { useView } from '../../engine/host';
import { Section, Seg } from '../../components/ui';
import { EditSlider } from './common';
import { makeSpline, makeParametric, CURVE_PRESETS } from '../../engine/curves';
import { linearCurve, type CurvePoint, type ToneCurve } from '@shared/edit';

type Channel = 'parametric' | 'rgb' | 'red' | 'green' | 'blue';
const CH_COLOR: Record<Channel, string> = { parametric: '#d8dbe0', rgb: '#e9ebee', red: '#ef5a5a', green: '#55c46a', blue: '#5b8cff' };
const SIZE = 248;

export function ToneCurvePanel() {
  const [ch, setCh] = useState<Channel>('parametric');
  const curve = useDevelop(s => s.edit.curve);
  const setEdit = useDevelop(s => s.setEdit);
  const tool = useDevelop(s => s.tool);
  const targeted = useDevelop(s => s.targetedMode);
  const reset = () => setEdit(e => { e.curve = { parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0, split: [0.25, 0.5, 0.75] }, rgb: linearCurve(), red: linearCurve(), green: linearCurve(), blue: linearCurve() }; }, 'Reset Tone Curve');
  return (
    <Section id="dev.curve" title="Tone Curve" onReset={reset}>
      <div className="row between mb8">
        <Seg value={ch} onChange={setCh} options={[
          { value: 'parametric', label: 'Region', title: 'Parametric curve' },
          { value: 'rgb', label: <span className="ch-dot" style={{ background: '#ddd' }} />, title: 'Point curve (RGB)' },
          { value: 'red', label: <span className="ch-dot" style={{ background: CH_COLOR.red }} />, title: 'Red channel' },
          { value: 'green', label: <span className="ch-dot" style={{ background: CH_COLOR.green }} />, title: 'Green channel' },
          { value: 'blue', label: <span className="ch-dot" style={{ background: CH_COLOR.blue }} />, title: 'Blue channel' },
        ]} />
        <button className={`icon-btn${tool === 'targeted' && targeted === 'curve' ? ' active' : ''}`} title="Targeted adjustment: drag up/down on the photo to adjust the curve at that tone"
          onClick={() => { useDevelop.getState().set({ targetedMode: 'curve' }); useDevelop.getState().setTool(tool === 'targeted' && targeted === 'curve' ? 'none' : 'targeted'); }}><Crosshair size={14} /></button>
      </div>
      <CurveEditor channel={ch} curve={curve} />
      {ch === 'parametric' ? <ParametricSliders /> : (
        <div className="row mt8">
          <select className="input sm grow" aria-label="Curve preset" value="" onChange={e => {
            const pts = CURVE_PRESETS[e.target.value];
            if (pts) setEdit(ed => { (ed.curve as any)[ch] = pts.map(p => ({ ...p })); }, `Curve: ${e.target.value}`);
          }}>
            <option value="">Curve preset…</option>
            {Object.keys(CURVE_PRESETS).map(k => <option key={k}>{k}</option>)}
          </select>
          <span className="dim small">Click to add · drag off to remove</span>
        </div>
      )}
    </Section>
  );
}

function ParametricSliders() {
  const p = (k: 'highlights' | 'lights' | 'darks' | 'shadows', label: string) => (
    <EditSlider label={label} min={-100} max={100} defaultValue={0} get={e => e.curve.parametric[k]} put={(e, v) => { e.curve.parametric[k] = v; }} />
  );
  return (
    <div className="mt8">
      {p('highlights', 'Highlights')}{p('lights', 'Lights')}{p('darks', 'Darks')}{p('shadows', 'Shadows')}
      <SplitControl />
    </div>
  );
}

function SplitControl() {
  const split = useDevelop(s => s.edit.curve.parametric.split);
  const setEdit = useDevelop(s => s.setEdit);
  const ref = useRef<HTMLDivElement>(null);
  const drag = (i: number) => (e: React.PointerEvent) => {
    const el = ref.current!;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      setEdit(ed => {
        const s = [...ed.curve.parametric.split] as [number, number, number];
        const lo = i === 0 ? 0.05 : s[i - 1] + 0.05, hi = i === 2 ? 0.95 : s[i + 1] - 0.05;
        s[i] = Math.round(Math.min(hi, Math.max(lo, x)) * 1000) / 1000;
        ed.curve.parametric.split = s;
      });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); useDevelop.getState().commit('Tone Curve Regions'); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="split-ctl" ref={ref} title="Drag to change where shadows, darks, lights and highlights meet">
      <div className="split-track" />
      {split.map((v, i) => <div key={i} className="split-knob" style={{ left: `${v * 100}%` }} onPointerDown={drag(i)} />)}
    </div>
  );
}

function CurveEditor({ channel, curve }: { channel: Channel; curve: ToneCurve }) {
  const setEdit = useDevelop(s => s.setEdit);
  const histo = useView(s => s.histo);
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts: CurvePoint[] = channel === 'parametric' ? [] : curve[channel];

  const path = useMemo(() => {
    const f = channel === 'parametric' ? makeParametric(curve.parametric) : makeSpline(pts);
    let d = '';
    for (let i = 0; i <= 128; i++) { const x = i / 128; const y = Math.min(1, Math.max(0, f(x))); d += `${i ? 'L' : 'M'}${(x * SIZE).toFixed(1)},${((1 - y) * SIZE).toFixed(1)}`; }
    return d;
  }, [channel, curve]);

  const histPath = useMemo(() => {
    if (!histo) return '';
    const a = histo.l;
    const max = Math.max(1, ...Array.from(a.slice(2, 254)));
    let d = `M0,${SIZE}`;
    for (let i = 0; i < 256; i++) d += `L${((i / 255) * SIZE).toFixed(1)},${(SIZE - Math.sqrt(a[i] / max) * SIZE * 0.9).toFixed(1)}`;
    return d + `L${SIZE},${SIZE}Z`;
  }, [histo]);

  const toXY = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)), outside: e.clientY < r.top - 24 || e.clientY > r.bottom + 24 || e.clientX < r.left - 24 || e.clientX > r.right + 24 };
  };

  const dragPoint = (index: number, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    let removed = false;
    const ch = channel as Exclude<Channel, 'parametric'>;
    const move = (ev: PointerEvent) => {
      const p = toXY(ev);
      setEdit(ed => {
        const list = [...ed.curve[ch]];
        const isEnd = index === 0 || index === list.length - 1;
        if (p.outside && !isEnd) { removed = true; return; }
        removed = false;
        const lo = index === 0 ? 0 : list[index - 1].x + 0.01, hi = index === list.length - 1 ? 1 : list[index + 1].x - 0.01;
        list[index] = { x: isEnd ? list[index].x : Math.min(hi, Math.max(lo, p.x)), y: p.y };
        ed.curve[ch] = list;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (removed) setEdit(ed => { ed.curve[ch] = ed.curve[ch].filter((_, i) => i !== index); });
      useDevelop.getState().commit('Tone Curve');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const addPoint = (e: React.PointerEvent) => {
    if (channel === 'parametric') return;
    const ch = channel;
    const p = toXY(e);
    const list = curve[ch];
    let i = list.findIndex(q => q.x > p.x);
    if (i <= 0) return;
    if (list.some(q => Math.abs(q.x - p.x) < 0.02)) return;
    const f = makeSpline(list);
    const np = { x: p.x, y: Math.abs(f(p.x) - p.y) < 0.06 ? f(p.x) : p.y };
    setEdit(ed => { const l = [...ed.curve[ch]]; l.splice(i, 0, np); ed.curve[ch] = l; });
    dragPoint(i, e);
  };

  return (
    <div className="curve-box">
      <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} className="curve-svg" onPointerDown={addPoint}
        onPointerMove={e => setHover(toXY(e).x)} onPointerLeave={() => setHover(null)} role="img" aria-label="Tone curve">
        {histPath && <path d={histPath} fill="rgba(255,255,255,0.06)" />}
        {[1, 2, 3].map(i => <React.Fragment key={i}><line x1={(i * SIZE) / 4} y1={0} x2={(i * SIZE) / 4} y2={SIZE} className="curve-grid" /><line x1={0} y1={(i * SIZE) / 4} x2={SIZE} y2={(i * SIZE) / 4} className="curve-grid" /></React.Fragment>)}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className="curve-diag" />
        {channel === 'parametric' && curve.parametric.split.map((s, i) => <line key={i} x1={s * SIZE} y1={0} x2={s * SIZE} y2={SIZE} className="curve-split" />)}
        <path d={path} fill="none" stroke={CH_COLOR[channel]} strokeWidth={1.6} />
        {pts.map((p, i) => <circle key={i} cx={p.x * SIZE} cy={(1 - p.y) * SIZE} r={4.5} className="curve-pt" onPointerDown={e => dragPoint(i, e)} onDoubleClick={() => { if (i > 0 && i < pts.length - 1) setEdit(ed => { (ed.curve as any)[channel] = pts.filter((_, j) => j !== i); }, 'Tone Curve'); }} />)}
      </svg>
      {hover != null && <div className="curve-readout">{Math.round(hover * 100)}%</div>}
    </div>
  );
}
