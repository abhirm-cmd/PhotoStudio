import React, { useEffect, useState } from 'react';
import { Wand2, Ruler, Upload, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2 } from 'lucide-react';
import { useDevelop } from '../../store/develop';
import { useApp } from '../../store/app';
import { Section, Seg, Slider } from '../../components/ui';
import { PathSlider, SubHead } from './common';
import { allProfiles, matchProfile, registerProfiles, parseLensfunXml } from '../../engine/lens';
import { activePhoto } from '../../store/library';
import { defaultEdit, type EditParams } from '@shared/edit';
import { api } from '../../api';
import { runUpright, autoStraightenAngle } from '../../analysis/upright';
import { useCropUi, setCropAspect, setStraighten, resetCrop } from '../CropOverlay';
import { ASPECTS } from '../../engine/geometry';

const resetGroup = (k: keyof EditParams, label: string) => useDevelop.getState().setEdit(e => { (e as any)[k] = structuredClone((defaultEdit(useDevelop.getState().isRaw) as any)[k]); }, `Reset ${label}`);

export function DetailPanel() {
  return (
    <Section id="dev.detail" title="Detail" onReset={() => resetGroup('detail', 'Detail')}>
      <SubHead>Sharpening</SubHead>
      <PathSlider path={['detail', 'sharpenAmount']} label="Amount" min={0} max={150} />
      <PathSlider path={['detail', 'sharpenRadius']} label="Radius" min={0.5} max={3} step={0.1} def={1} />
      <PathSlider path={['detail', 'sharpenDetail']} label="Detail" min={0} max={100} def={25} />
      <PathSlider path={['detail', 'sharpenMasking']} label="Masking" min={0} max={100} title="Restrict sharpening to edges" />
      <SubHead>Noise Reduction</SubHead>
      <PathSlider path={['detail', 'noiseReduction']} label="Luminance" min={0} max={100} />
      <PathSlider path={['detail', 'noiseDetail']} label="Detail" min={0} max={100} def={50} />
      <PathSlider path={['detail', 'colorNoiseReduction']} label="Color" min={0} max={100} />
      <p className="dim small">Judge sharpening and noise at 100% zoom (click the photo).</p>
    </Section>
  );
}

export function OpticsPanel() {
  const optics = useDevelop(s => s.edit.optics);
  const setEdit = useDevelop(s => s.setEdit);
  const photo = activePhoto();
  const [, force] = useState(0);
  useEffect(() => { loadSavedLensProfiles().then(() => force(x => x + 1)); }, []);
  const matched = photo ? matchProfile(photo.exif.lens, photo.exif.make) : undefined;
  const profiles = allProfiles();
  const importDb = async () => {
    const files = await api.openTextFiles('Import Lensfun database', ['xml']);
    let n = 0;
    for (const f of files) { const list = parseLensfunXml(f.text, f.name); registerProfiles(list); n += list.length; }
    if (n) { await api.saveLensProfiles(allProfiles().filter(p => p.source !== 'generic')); force(x => x + 1); }
    useApp.getState().toast({ kind: n ? 'success' : 'info', title: n ? `Imported ${n} lens profile${n > 1 ? 's' : ''}` : 'No lens profiles found in that file', body: n ? 'Profiles are matched to photos by the lens name in EXIF.' : 'Choose a Lensfun XML database file (e.g. slr-canon.xml).' });
  };
  return (
    <Section id="dev.optics" title="Lens Corrections" onReset={() => resetGroup('optics', 'Lens Corrections')}>
      <label className="check"><input type="checkbox" checked={optics.enableProfile} onChange={e => setEdit(ed => { ed.optics.enableProfile = e.target.checked; }, e.target.checked ? 'Enable Lens Profile' : 'Disable Lens Profile')} />Enable profile corrections</label>
      {optics.enableProfile && (
        <div className="field mt8">
          <label>Lens profile</label>
          <select className="input sm" value={optics.profileId ?? ''} onChange={e => setEdit(ed => { ed.optics.profileId = e.target.value || null; }, 'Lens Profile')}>
            <option value="">{matched ? `Auto: ${matched.make} ${matched.model}` : 'Auto (no match for this lens)'}</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.make} {p.model}{p.source === 'generic' ? ' (generic)' : ''}</option>)}
          </select>
          {photo?.exif.lens && <span className="dim small">Lens in EXIF: {photo.exif.lens}</span>}
        </div>
      )}
      <label className="check mt8"><input type="checkbox" checked={optics.removeCA} onChange={e => setEdit(ed => { ed.optics.removeCA = e.target.checked; }, 'Remove Chromatic Aberration')} />Remove chromatic aberration (from profile)</label>
      <button className="btn sm ghost mt8" onClick={importDb}><Upload size={12} />Import Lensfun database…</button>
      <SubHead>Manual</SubHead>
      <PathSlider path={['optics', 'distortion']} label="Distortion" title="Positive corrects barrel distortion, negative corrects pincushion" />
      <PathSlider path={['optics', 'vignetting']} label="Vignetting" title="Brighten (positive) or darken lens vignetting" />
      <PathSlider path={['optics', 'vignettingMidpoint']} label="Midpoint" min={0} max={100} def={50} />
      <PathSlider path={['optics', 'caRed']} label="Red / Cyan fringe" />
      <PathSlider path={['optics', 'caBlue']} label="Blue / Yellow fringe" />
      <SubHead>Defringe</SubHead>
      <PathSlider path={['optics', 'defringePurple']} label="Purple" min={0} max={20} />
      <PathSlider path={['optics', 'defringeGreen']} label="Green" min={0} max={20} />
    </Section>
  );
}

let lensLoaded = false;
export async function loadSavedLensProfiles() {
  if (lensLoaded) return;
  lensLoaded = true;
  try { registerProfiles(await api.lensProfiles()); } catch { /* none saved */ }
}

export function TransformPanel() {
  const upright = useDevelop(s => s.edit.transform.upright);
  const tool = useDevelop(s => s.tool);
  const guides = useDevelop(s => s.edit.transform.guides.length);
  const [busy, setBusy] = useState(false);
  const run = async (mode: 'auto' | 'level' | 'vertical' | 'full') => {
    setBusy(true);
    try { await runUpright(mode); } finally { setBusy(false); }
  };
  return (
    <Section id="dev.transform" title="Transform" onReset={() => resetGroup('transform', 'Transform')}>
      <SubHead>Upright</SubHead>
      <div className="upright-grid">
        {(['off', 'auto', 'level', 'vertical', 'full'] as const).map(m => (
          <button key={m} className={`btn sm${upright === m ? ' active' : ''}`} disabled={busy}
            onClick={() => (m === 'off' ? useDevelop.getState().setEdit(e => { e.transform = { ...defaultEdit().transform }; }, 'Upright: Off') : run(m))}>
            {m === 'off' ? 'Off' : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
        <button className={`btn sm${tool === 'upright-guides' ? ' active' : ''}`} onClick={() => useDevelop.getState().setTool('upright-guides')} title="Draw 2–4 guides along lines that should be vertical or horizontal"><Ruler size={12} />Guided{guides ? ` (${guides})` : ''}</button>
      </div>
      {tool === 'upright-guides' && <p className="dim small">Drag on the photo along lines that should be straight (vertical or horizontal). Two to four guides. Esc to finish.</p>}
      <SubHead>Manual</SubHead>
      <PathSlider path={['transform', 'vertical']} label="Vertical" />
      <PathSlider path={['transform', 'horizontal']} label="Horizontal" />
      <PathSlider path={['transform', 'rotate']} label="Rotate" min={-10} max={10} step={0.1} />
      <PathSlider path={['transform', 'aspect']} label="Aspect" />
      <PathSlider path={['transform', 'scale']} label="Scale" min={50} max={150} def={100} />
      <PathSlider path={['transform', 'offsetX']} label="X Offset" />
      <PathSlider path={['transform', 'offsetY']} label="Y Offset" />
    </Section>
  );
}

export function EffectsPanel() {
  return (
    <Section id="dev.effects" title="Effects" onReset={() => useDevelop.getState().setEdit(e => {
      const d = defaultEdit().effects;
      Object.assign(e.effects, { vignetteAmount: d.vignetteAmount, vignetteMidpoint: d.vignetteMidpoint, vignetteRoundness: d.vignetteRoundness, vignetteFeather: d.vignetteFeather, vignetteHighlights: d.vignetteHighlights, grainAmount: d.grainAmount, grainSize: d.grainSize, grainRoughness: d.grainRoughness });
    }, 'Reset Effects')}>
      <SubHead>Post-Crop Vignetting</SubHead>
      <PathSlider path={['effects', 'vignetteAmount']} label="Amount" />
      <PathSlider path={['effects', 'vignetteMidpoint']} label="Midpoint" min={0} max={100} def={50} />
      <PathSlider path={['effects', 'vignetteRoundness']} label="Roundness" />
      <PathSlider path={['effects', 'vignetteFeather']} label="Feather" min={0} max={100} def={50} />
      <PathSlider path={['effects', 'vignetteHighlights']} label="Highlights" min={0} max={100} />
      <SubHead>Grain</SubHead>
      <PathSlider path={['effects', 'grainAmount']} label="Amount" min={0} max={100} />
      <PathSlider path={['effects', 'grainSize']} label="Size" min={0} max={100} def={25} />
      <PathSlider path={['effects', 'grainRoughness']} label="Roughness" min={0} max={100} def={50} />
    </Section>
  );
}

/** Crop & straighten controls, shown while the crop tool is active. */
export function CropPanel() {
  const crop = useDevelop(s => s.edit.crop);
  const setEdit = useDevelop(s => s.setEdit);
  const guide = useCropUi(s => s.guide);
  const setGuide = useCropUi(s => s.set);
  const [busy, setBusy] = useState(false);
  return (
    <Section id="dev.crop" title="Crop & Straighten" onReset={() => resetCrop()}>
      <div className="field-row">
        <label>Aspect</label>
        <select className="input sm grow" value={crop.aspect} onChange={e => setCropAspect(e.target.value)} aria-label="Aspect ratio">
          {Object.keys(ASPECTS).map(a => <option key={a} value={a}>{a === 'free' ? 'Free' : a === 'original' ? 'Original' : a}</option>)}
        </select>
        <button className="icon-btn" title="Swap orientation" onClick={() => { const [a, b] = crop.aspect.split(':'); if (b) setCropAspect(`${b}:${a}`); }}>⇄</button>
      </div>
      <Slider label="Straighten" min={-45} max={45} step={0.05} defaultValue={0} value={crop.angle} format={v => `${v > 0 ? '+' : ''}${v.toFixed(2)}°`}
        onChange={v => setStraighten(v)} onCommit={() => useDevelop.getState().commit('Straighten')} />
      <div className="btn-row mt8">
        <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); const a = await autoStraightenAngle(); if (a != null) setStraighten(a, true); else useApp.getState().toast({ kind: 'info', title: 'No clear horizon or verticals found' }); setBusy(false); }}><Wand2 size={12} />Auto straighten</button>
        <button className="icon-btn" title="Rotate left" onClick={() => setEdit(e => { e.crop.orientation = (e.crop.orientation + 270) % 360; Object.assign(e.crop, { x: 0, y: 0, w: 1, h: 1 }); }, 'Rotate Left')}><RotateCcw size={14} /></button>
        <button className="icon-btn" title="Rotate right" onClick={() => setEdit(e => { e.crop.orientation = (e.crop.orientation + 90) % 360; Object.assign(e.crop, { x: 0, y: 0, w: 1, h: 1 }); }, 'Rotate Right')}><RotateCw size={14} /></button>
        <button className={`icon-btn${crop.flipH ? ' active' : ''}`} title="Flip horizontal" onClick={() => setEdit(e => { e.crop.flipH = !e.crop.flipH; e.crop.x = 1 - e.crop.x - e.crop.w; }, 'Flip Horizontal')}><FlipHorizontal2 size={14} /></button>
        <button className={`icon-btn${crop.flipV ? ' active' : ''}`} title="Flip vertical" onClick={() => setEdit(e => { e.crop.flipV = !e.crop.flipV; e.crop.y = 1 - e.crop.y - e.crop.h; }, 'Flip Vertical')}><FlipVertical2 size={14} /></button>
      </div>
      <div className="field-row mt8">
        <label>Overlay</label>
        <Seg value={guide} onChange={setGuide} options={[{ value: 'thirds', label: 'Thirds' }, { value: 'grid', label: 'Grid' }, { value: 'golden', label: 'Golden' }, { value: 'diagonal', label: 'Diag' }, { value: 'none', label: 'None' }]} />
      </div>
      <p className="dim small">Drag corners to resize, inside to move, outside to straighten. Enter or double-click to finish.</p>
      <button className="btn sm primary block mt8" onClick={() => useDevelop.getState().set({ tool: 'none' })}>Done</button>
    </Section>
  );
}

