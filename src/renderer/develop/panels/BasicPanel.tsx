import React from 'react';
import { Pipette, Wand2, Sparkles } from 'lucide-react';
import { useDevelop } from '../../store/develop';
import { Section, Slider } from '../../components/ui';
import { KeySlider, PathSlider, G, SubHead } from './common';
import { profilesFor } from '../../engine/profiles';
import { kelvinToRel, relToKelvin } from '@shared/color';
import { autoTone, autoWhiteBalance } from '../../analysis/autoTone';
import { runAutoEnhance } from '../../analysis/enhance';
import { defaultEdit } from '@shared/edit';

export function ProfileRow() {
  const isRaw = useDevelop(s => s.isRaw);
  const profile = useDevelop(s => s.edit.profile);
  const setEdit = useDevelop(s => s.setEdit);
  const list = profilesFor(isRaw);
  const cur = list.find(p => p.id === profile);
  return (
    <div className="field-row">
      <label>Profile</label>
      <select className="input sm grow" value={profile} onChange={e => setEdit(ed => { ed.profile = e.target.value; }, `Profile: ${list.find(p => p.id === e.target.value)?.name}`)} title={cur?.description} aria-label="Profile">
        {list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

export function WhiteBalance() {
  const isRaw = useDevelop(s => s.isRaw);
  const wb = useDevelop(s => s.edit.wb);
  const asShot = useDevelop(s => s.asShot);
  const tool = useDevelop(s => s.tool);
  const setEdit = useDevelop(s => s.setEdit);
  const setTool = useDevelop(s => s.setTool);
  const commit = () => useDevelop.getState().commit();
  const modeLabel = wb.mode === 'asShot' ? 'asShot' : wb.mode === 'auto' ? 'auto' : 'custom';
  // RAW: temperature slider runs on a perceptual (mired) scale and shows Kelvin; non-RAW shows a relative -100..+100 shift.
  const rel = kelvinToRel(wb.temp) - (isRaw ? 0 : kelvinToRel(asShot.temp));
  return (
    <>
      <div className="field-row">
        <label>WB</label>
        <select className="input sm grow" value={modeLabel} aria-label="White balance mode" onChange={e => {
          const v = e.target.value;
          if (v === 'asShot') setEdit(ed => { ed.wb = { mode: 'asShot', temp: asShot.temp, tint: asShot.tint }; }, 'White Balance: As Shot');
          else if (v === 'auto') autoWhiteBalance();
          else setEdit(ed => { ed.wb.mode = 'custom'; });
        }}>
          <option value="asShot">{isRaw ? 'As Shot' : 'Original'}</option>
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
        <button className={`icon-btn${tool === 'wb' ? ' active' : ''}`} onClick={() => setTool('wb')} title="White balance picker (W)" aria-label="White balance picker"><Pipette size={14} /></button>
      </div>
      <Slider label="Temp" gradient={G.temp}
        min={isRaw ? kelvinToRel(2000) : -100} max={isRaw ? kelvinToRel(50000) : 100} step={isRaw ? 0.5 : 1}
        defaultValue={isRaw ? kelvinToRel(asShot.temp) : 0}
        value={rel}
        format={v => (isRaw ? `${Math.round(relToKelvin(v) / 10) * 10}` : `${v > 0 ? '+' : ''}${Math.round(v)}`)}
        parse={s => { const n = parseFloat(s); return isRaw ? kelvinToRel(Math.max(2000, Math.min(50000, n))) : n; }}
        onChange={v => setEdit(ed => { ed.wb.mode = 'custom'; ed.wb.temp = relToKelvin(v + (isRaw ? 0 : kelvinToRel(asShot.temp))); })}
        onCommit={commit} />
      <Slider label="Tint" gradient={G.tint} min={-150} max={150} defaultValue={asShot.tint} value={wb.tint}
        onChange={v => setEdit(ed => { ed.wb.mode = 'custom'; ed.wb.tint = v; })} onCommit={commit} />
    </>
  );
}

export function BasicPanel() {
  const setEdit = useDevelop(s => s.setEdit);
  const isRaw = useDevelop(s => s.isRaw);
  const reset = () => setEdit(e => {
    const d = defaultEdit(isRaw);
    for (const k of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] as const) e[k] = d[k];
    e.effects.texture = 0; e.effects.clarity = 0; e.effects.dehaze = 0;
    e.wb = { mode: 'asShot', temp: useDevelop.getState().asShot.temp, tint: useDevelop.getState().asShot.tint };
  }, 'Reset Basic');
  return (
    <Section id="dev.basic" title="Basic" onReset={reset}>
      <ProfileRow />
      <WhiteBalance />
      <div className="row between mt8">
        <SubHead>Tone</SubHead>
        <div className="btn-row tight">
          <button className="btn sm" onClick={() => autoTone()} title="Auto tone (Ctrl/Cmd+U)"><Wand2 size={12} />Auto</button>
          <button className="btn sm" onClick={() => runAutoEnhance(0.7)} title="AI Auto Enhance (Ctrl/Cmd+Shift+A)"><Sparkles size={12} className="accent" />Enhance</button>
        </div>
      </div>
      <KeySlider k="exposure" label="Exposure" min={-5} max={5} step={0.01} format={v => `${v > 0 ? '+' : ''}${v.toFixed(2)}`} />
      <KeySlider k="contrast" label="Contrast" />
      <KeySlider k="highlights" label="Highlights" />
      <KeySlider k="shadows" label="Shadows" />
      <KeySlider k="whites" label="Whites" />
      <KeySlider k="blacks" label="Blacks" />
      <SubHead>Presence</SubHead>
      <PathSlider path={['effects', 'texture']} label="Texture" />
      <PathSlider path={['effects', 'clarity']} label="Clarity" />
      <PathSlider path={['effects', 'dehaze']} label="Dehaze" />
      <KeySlider k="vibrance" label="Vibrance" gradient={G.vib} />
      <KeySlider k="saturation" label="Saturation" gradient={G.sat} />
    </Section>
  );
}
