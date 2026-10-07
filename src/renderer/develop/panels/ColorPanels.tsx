import React, { useRef, useState } from 'react';
import { Crosshair, Link2, Link2Off } from 'lucide-react';
import { useDevelop } from '../../store/develop';
import { Section, Seg, Slider } from '../../components/ui';
import { EditSlider, PathSlider, G, SubHead } from './common';
import { HSL_CHANNELS, type HslChannel, type GradeWheel, type ColorGrading } from '@shared/edit';
import { HSL_CENTERS, lchToOklab, oklabToLinearSrgb, linearToSrgb } from '@shared/color';

const NAMES: Record<HslChannel, string> = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta' };

/** CSS color for an OkLCh hue at given lightness/chroma. */
export function hueCss(h: number, L = 0.72, C = 0.14) {
  const rgb = oklabToLinearSrgb(lchToOklab([L, C, h]));
  return `rgb(${rgb.map(v => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)).join(',')})`;
}

function channelGradient(ch: HslChannel, kind: 'hue' | 'saturation' | 'luminance') {
  const h = HSL_CENTERS[HSL_CHANNELS.indexOf(ch)];
  if (kind === 'hue') return `linear-gradient(90deg, ${hueCss(h - 40)}, ${hueCss(h)}, ${hueCss(h + 40)})`;
  if (kind === 'saturation') return `linear-gradient(90deg, ${hueCss(h, 0.72, 0)}, ${hueCss(h, 0.72, 0.17)})`;
  return `linear-gradient(90deg, ${hueCss(h, 0.3, 0.08)}, ${hueCss(h, 0.92, 0.06)})`;
}

export function HslPanel() {
  const [mode, setMode] = useState<'hue' | 'saturation' | 'luminance' | 'all'>('hue');
  const tool = useDevelop(s => s.tool);
  const targetedMode = useDevelop(s => s.targetedMode);
  const setEdit = useDevelop(s => s.setEdit);
  const reset = () => setEdit(e => { for (const c of HSL_CHANNELS) e.hsl[c] = { hue: 0, saturation: 0, luminance: 0 }; }, 'Reset Color Mixer');
  const kinds = mode === 'all' ? (['hue', 'saturation', 'luminance'] as const) : [mode];
  const targetKind = mode === 'all' ? 'saturation' : mode;
  const targetOn = tool === 'targeted' && targetedMode !== 'curve';
  return (
    <Section id="dev.hsl" title="Color Mixer" onReset={reset}>
      <div className="row between mb8">
        <Seg value={mode} onChange={setMode} options={[{ value: 'hue', label: 'Hue' }, { value: 'saturation', label: 'Saturation' }, { value: 'luminance', label: 'Luminance' }, { value: 'all', label: 'All' }]} />
        <button className={`icon-btn${targetOn ? ' active' : ''}`} title="Targeted adjustment: drag up/down on a color in the photo"
          onClick={() => { useDevelop.getState().set({ targetedMode: targetKind }); useDevelop.getState().setTool(targetOn ? 'none' : 'targeted'); }}><Crosshair size={14} /></button>
      </div>
      {kinds.map(k => (
        <React.Fragment key={k}>
          {mode === 'all' && <SubHead>{k[0].toUpperCase() + k.slice(1)}</SubHead>}
          {HSL_CHANNELS.map(ch => (
            <EditSlider key={ch} label={NAMES[ch]} min={-100} max={100} defaultValue={0} gradient={channelGradient(ch, k)}
              get={e => e.hsl[ch][k]} put={(e, v) => { e.hsl[ch][k] = v; }} />
          ))}
        </React.Fragment>
      ))}
      {targetOn && <p className="dim small mt8">Drag up or down on the photo to change {targetKind} of the color under the cursor. Press Esc when done.</p>}
    </Section>
  );
}

/* --------------------------------------------------------------- grading */

function Wheel({ value, onChange, onCommit, size = 108, label }: { value: GradeWheel; onChange(v: GradeWheel): void; onCommit(): void; size?: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const r = size / 2;
  const ang = (value.hue * Math.PI) / 180;
  const px = r + Math.cos(ang) * (value.sat / 100) * (r - 6), py = r - Math.sin(ang) * (value.sat / 100) * (r - 6);
  const drag = (e: React.PointerEvent) => {
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const fine = (ev: PointerEvent | React.PointerEvent) => ev.shiftKey;
    let last = { x: e.clientX, y: e.clientY };
    let cur = value;
    const at = (ev: { clientX: number; clientY: number; shiftKey: boolean }) => {
      let dx: number, dy: number;
      if (fine(ev as any)) {
        // Shift: fine movement relative to the current point
        const cx = Math.cos((cur.hue * Math.PI) / 180) * (cur.sat / 100), cy = Math.sin((cur.hue * Math.PI) / 180) * (cur.sat / 100);
        dx = cx + ((ev.clientX - last.x) / (r - 6)) * 0.2; dy = cy - ((ev.clientY - last.y) / (r - 6)) * 0.2;
      } else {
        dx = (ev.clientX - rect.left - r) / (r - 6); dy = -(ev.clientY - rect.top - r) / (r - 6);
      }
      last = { x: ev.clientX, y: ev.clientY };
      const sat = Math.min(100, Math.hypot(dx, dy) * 100);
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      cur = { ...cur, hue: Math.round(hue), sat: Math.round(sat * 10) / 10 };
      onChange(cur);
    };
    at(e as any);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onCommit(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <div className="wheel-wrap">
      <div className="wheel" ref={ref} style={{ width: size, height: size }} onPointerDown={drag} onDoubleClick={() => { onChange({ ...value, hue: 0, sat: 0 }); onCommit(); }}
        role="slider" aria-label={`${label} color`} aria-valuetext={`hue ${value.hue}, saturation ${value.sat}`} tabIndex={0}
        onKeyDown={e => {
          const d = e.shiftKey ? 10 : 2;
          if (e.key === 'ArrowLeft') onChange({ ...value, hue: (value.hue + d) % 360 });
          else if (e.key === 'ArrowRight') onChange({ ...value, hue: (value.hue - d + 360) % 360 });
          else if (e.key === 'ArrowUp') onChange({ ...value, sat: Math.min(100, value.sat + d) });
          else if (e.key === 'ArrowDown') onChange({ ...value, sat: Math.max(0, value.sat - d) });
          else return;
          e.preventDefault(); e.stopPropagation(); onCommit();
        }}>
        <div className="wheel-dot" style={{ left: px, top: py, background: value.sat > 1 ? hueCss(value.hue, 0.75, 0.12) : '#ddd' }} />
      </div>
      <div className="wheel-label"><span>{label}</span><span className="dim">{value.sat > 0.5 ? `${Math.round(value.hue)}° · ${Math.round(value.sat)}` : ''}</span></div>
    </div>
  );
}

function GradeWheelControl({ k, label, size }: { k: keyof Pick<ColorGrading, 'shadows' | 'midtones' | 'highlights' | 'global'>; label: string; size?: number }) {
  const v = useDevelop(s => s.edit.grading[k]);
  const setEdit = useDevelop(s => s.setEdit);
  return (
    <div className="grade-cell">
      <Wheel label={label} value={v} size={size} onChange={nv => setEdit(e => { e.grading[k] = { ...e.grading[k], hue: nv.hue, sat: nv.sat }; })} onCommit={() => useDevelop.getState().commit(`Color Grading: ${label}`)} />
      <EditSlider label="Luminance" min={-100} max={100} defaultValue={0} get={e => e.grading[k].lum} put={(e, x) => { e.grading[k].lum = x; }} gradient={G.lum} />
    </div>
  );
}

export function GradingPanel() {
  const [view, setView] = useState<'3way' | 'shadows' | 'midtones' | 'highlights' | 'global'>('3way');
  const setEdit = useDevelop(s => s.setEdit);
  const reset = () => setEdit(e => { const w = () => ({ hue: 0, sat: 0, lum: 0 }); e.grading = { shadows: w(), midtones: w(), highlights: w(), global: w(), blending: 50, balance: 0 }; }, 'Reset Color Grading');
  const names = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights', global: 'Global' } as const;
  return (
    <Section id="dev.grading" title="Color Grading" onReset={reset}>
      <Seg value={view} onChange={setView} full options={[{ value: '3way', label: '3-Way' }, { value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Mid' }, { value: 'highlights', label: 'High' }, { value: 'global', label: 'Global' }]} />
      {view === '3way' ? (
        <div className="grade-3way mt8">
          <div className="grade-top"><GradeWheelControl k="midtones" label="Midtones" size={96} /></div>
          <div className="grade-row"><GradeWheelControl k="shadows" label="Shadows" size={96} /><GradeWheelControl k="highlights" label="Highlights" size={96} /></div>
          <GradeWheelControl k="global" label="Global" size={96} />
        </div>
      ) : (
        <div className="grade-single mt8"><GradeWheelControl k={view} label={names[view]} size={176} /></div>
      )}
      <PathSlider path={['grading', 'blending']} label="Blending" min={0} max={100} def={50} />
      <PathSlider path={['grading', 'balance']} label="Balance" />
    </Section>
  );
}

export function CalibrationPanel() {
  const setEdit = useDevelop(s => s.setEdit);
  const reset = () => setEdit(e => { e.calibration = { shadowTint: 0, redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 }; }, 'Reset Calibration');
  const prim = (c: 'red' | 'green' | 'blue', label: string, h: number) => (
    <>
      <SubHead>{label} Primary</SubHead>
      <PathSlider path={['calibration', `${c}Hue`]} label="Hue" gradient={`linear-gradient(90deg, ${hueCss(h - 35)}, ${hueCss(h)}, ${hueCss(h + 35)})`} />
      <PathSlider path={['calibration', `${c}Sat`]} label="Saturation" gradient={`linear-gradient(90deg, ${hueCss(h, 0.7, 0.02)}, ${hueCss(h, 0.7, 0.2)})`} />
    </>
  );
  return (
    <Section id="dev.calibration" title="Calibration" defaultOpen={false} onReset={reset}>
      <PathSlider path={['calibration', 'shadowTint']} label="Shadows Tint" gradient={G.tint} />
      {prim('red', 'Red', 29)}{prim('green', 'Green', 142)}{prim('blue', 'Blue', 264)}
    </Section>
  );
}

export { Slider, Link2, Link2Off };
