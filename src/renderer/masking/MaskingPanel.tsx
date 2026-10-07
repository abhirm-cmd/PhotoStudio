import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Plus, Minus, SquareStack, Trash2, MoreHorizontal, User, Cloud, Image as ImageIcon, Users, BoxSelect, Paintbrush, Circle, RectangleHorizontal, Pipette, SunMedium, RefreshCw, FlipHorizontal } from 'lucide-react';
import { useDevelop } from '../store/develop';
import { Section, Slider, openMenu, Empty, promptText, type MenuItem } from '../components/ui';
import { G, SubHead } from '../develop/panels/common';
import { createMask, addComponent, updateMask, updateComponent, deleteMask, duplicateMask, regenerateAi, busyMask, KIND_LABEL, type NewKind } from './maskOps';
import { defaultLocal, type Mask, type MaskComponent, type MaskOp, type LocalAdjustments } from '@shared/edit';
import { hueCss } from '../develop/panels/ColorPanels';
import { MAX_MASKS } from '../engine/params';
export { MaskOverlay } from './MaskOverlay';

const CREATE: { kind: NewKind; label: string; icon: React.ReactNode; ai?: boolean }[] = [
  { kind: 'subject', label: 'Subject', icon: <User size={15} />, ai: true },
  { kind: 'sky', label: 'Sky', icon: <Cloud size={15} />, ai: true },
  { kind: 'background', label: 'Background', icon: <ImageIcon size={15} />, ai: true },
  { kind: 'people', label: 'People', icon: <Users size={15} />, ai: true },
  { kind: 'object', label: 'Object', icon: <BoxSelect size={15} />, ai: true },
  { kind: 'brush', label: 'Brush', icon: <Paintbrush size={15} /> },
  { kind: 'linear', label: 'Linear', icon: <RectangleHorizontal size={15} /> },
  { kind: 'radial', label: 'Radial', icon: <Circle size={15} /> },
  { kind: 'color', label: 'Color', icon: <Pipette size={15} /> },
  { kind: 'luminance', label: 'Luminance', icon: <SunMedium size={15} /> },
];

function useBusy() {
  const [, f] = useState(0);
  useEffect(() => { const l = () => f(x => x + 1); busyMask.listeners.add(l); return () => { busyMask.listeners.delete(l); }; }, []);
  return busyMask.current;
}

const componentMenu = (maskId: string, op: MaskOp): MenuItem[] => CREATE.map(c => ({ label: c.label, icon: c.icon, onClick: () => addComponent(maskId, c.kind, op) }));

export function MaskingPanel() {
  const masks = useDevelop(s => s.edit.masks);
  const selected = useDevelop(s => s.selectedMask);
  const busy = useBusy();
  const sel = masks.find(m => m.id === selected) ?? null;
  return (
    <>
      <Section id="mask.create" title={<>Create Mask <span className="tag local">On-device</span></>}>
        <div className="mask-create">
          {CREATE.map(c => (
            <button key={c.kind} className="mask-create-btn" disabled={!!busy || masks.length >= MAX_MASKS} onClick={() => createMask(c.kind)} title={c.ai ? `Detect ${c.label.toLowerCase()} automatically` : `Add a ${c.label.toLowerCase()} mask`}>
              {c.icon}<span>{c.label}</span>
            </button>
          ))}
        </div>
        {busy && <div className="row small muted mt8"><div className="spinner" />{busy}</div>}
      </Section>
      <Section id="mask.list" title={`Masks${masks.length ? ` · ${masks.length}` : ''}`}>
        {masks.length ? masks.map(m => <MaskRow key={m.id} mask={m} active={m.id === selected} />) : (
          <Empty kind="masks" title="No masks yet" small><p>Masks apply adjustments to part of the photo. Start with Subject or Sky, or paint with the Brush.</p></Empty>
        )}
      </Section>
      {sel && <MaskSettings mask={sel} />}
      {sel && <LocalAdjustPanel mask={sel} />}
    </>
  );
}

function MaskRow({ mask, active }: { mask: Mask; active: boolean }) {
  const selComp = useDevelop(s => s.selectedComponent);
  const set = useDevelop(s => s.set);
  const overlay = useDevelop(s => s.maskOverlay);
  const menu = (e: React.MouseEvent) => openMenu(e, [
    { label: 'Rename…', onClick: async () => { const n = await promptText('Rename mask', mask.name); if (n) updateMask(mask.id, m => { m.name = n; }, 'Rename Mask'); } },
    { label: 'Duplicate', onClick: () => duplicateMask(mask.id) },
    { label: mask.invert ? 'Un-invert' : 'Invert', onClick: () => updateMask(mask.id, m => { m.invert = !m.invert; }, 'Invert Mask') },
    { label: 'Reset Adjustments', onClick: () => updateMask(mask.id, m => { m.adjust = defaultLocal(); }, 'Reset Mask Adjustments') },
    { sep: true },
    { label: 'Delete Mask', danger: true, icon: <Trash2 size={14} />, onClick: () => deleteMask(mask.id) },
  ]);
  return (
    <div className={`mask-row${active ? ' active' : ''}`}>
      <div className="mask-row-head" onClick={() => set({ selectedMask: mask.id, selectedComponent: mask.components[0]?.id ?? null })} onContextMenu={menu}>
        <button className="icon-btn sm" onClick={e => { e.stopPropagation(); updateMask(mask.id, m => { m.visible = !m.visible; }, mask.visible ? 'Hide Mask' : 'Show Mask'); }} aria-label={mask.visible ? 'Hide mask' : 'Show mask'}>{mask.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
        <span className="name">{mask.name}{mask.invert && <span className="dim"> (inverted)</span>}</span>
        {active && <button className={`btn sm ghost${overlay ? ' active' : ''}`} onClick={e => { e.stopPropagation(); set({ maskOverlay: !overlay }); }} title="Show overlay (O)">Overlay</button>}
        <button className="icon-btn sm" onClick={e => { e.stopPropagation(); menu(e); }} aria-label="Mask options"><MoreHorizontal size={13} /></button>
      </div>
      {active && (
        <div className="mask-comps">
          {mask.components.map(c => (
            <div key={c.id} className={`comp-row${selComp === c.id ? ' active' : ''}`} onClick={() => set({ selectedComponent: c.id, tool: c.type === 'brush' ? 'brush' : useDevelop.getState().tool === 'brush' ? 'none' : useDevelop.getState().tool })}>
              <span className={`op op-${c.op}`}>{c.op === 'add' ? '+' : c.op === 'subtract' ? '−' : '∩'}</span>
              <span className="name">{compLabel(c)}{c.invert ? ' (inverted)' : ''}</span>
              {c.type === 'ai' && <span className="tag local" title={c.provider}>{c.provider.includes('heuristic') ? 'Heuristic' : 'Model'}</span>}
              <button className="icon-btn sm" title="Invert this part" onClick={e => { e.stopPropagation(); updateComponent(mask.id, c.id, x => { x.invert = !x.invert; }, 'Invert Mask Part'); }}><FlipHorizontal size={11} /></button>
              {c.type === 'ai' && c.target !== 'object' && <button className="icon-btn sm" title="Detect again" onClick={e => { e.stopPropagation(); regenerateAi(mask.id, c.id); }}><RefreshCw size={11} /></button>}
              <button className="icon-btn sm" title="Remove" onClick={e => { e.stopPropagation(); updateMask(mask.id, m => { m.components = m.components.filter(x => x.id !== c.id); }, 'Remove Mask Part'); }}><Trash2 size={11} /></button>
            </div>
          ))}
          <div className="btn-row tight mt8">
            <button className="btn sm" onClick={e => openMenu(e, componentMenu(mask.id, 'add'))}><Plus size={12} />Add</button>
            <button className="btn sm" onClick={e => openMenu(e, componentMenu(mask.id, 'subtract'))}><Minus size={12} />Subtract</button>
            <button className="btn sm" onClick={e => openMenu(e, componentMenu(mask.id, 'intersect'))}><SquareStack size={12} />Intersect</button>
          </div>
        </div>
      )}
    </div>
  );
}

function compLabel(c: MaskComponent) {
  if (c.type === 'ai') return KIND_LABEL[c.target] ?? c.target;
  return KIND_LABEL[c.type];
}

function MaskSettings({ mask }: { mask: Mask }) {
  const selComp = useDevelop(s => s.selectedComponent);
  const brush = useDevelop(s => s.brush);
  const tool = useDevelop(s => s.tool);
  const set = useDevelop(s => s.set);
  const comp = mask.components.find(c => c.id === selComp) ?? null;
  const commit = () => useDevelop.getState().commit();
  const ms = (label: string, k: 'density' | 'feather' | 'refine', title?: string) => (
    <Slider label={label} min={0} max={100} defaultValue={k === 'density' ? 100 : 0} value={mask[k]} title={title}
      onChange={v => updateMask(mask.id, m => { m[k] = v; })} onCommit={commit} />
  );
  return (
    <Section id="mask.settings" title="Mask Settings">
      {ms('Density', 'density', 'How strongly the adjustments apply')}
      {ms('Feather', 'feather', 'Softens the whole mask edge')}
      {ms('Refine Edges', 'refine', 'Snaps the mask edge to detail in the photo (hair, branches)')}
      {comp?.type === 'brush' && (
        <>
          <SubHead>Brush</SubHead>
          <div className="btn-row tight mb8">
            <button className={`btn sm${tool === 'brush' && !brush.erase ? ' active' : ''}`} onClick={() => set({ tool: 'brush', brush: { ...brush, erase: false } })}>Paint</button>
            <button className={`btn sm${tool === 'brush' && brush.erase ? ' active' : ''}`} onClick={() => set({ tool: 'brush', brush: { ...brush, erase: true } })}>Erase</button>
          </div>
          <Slider label="Size" min={4} max={600} defaultValue={120} value={brush.size} onChange={v => set({ brush: { ...useDevelop.getState().brush, size: v } })} />
          <Slider label="Feather" min={0} max={100} defaultValue={60} value={brush.feather} onChange={v => set({ brush: { ...useDevelop.getState().brush, feather: v } })} />
          <Slider label="Flow" min={1} max={100} defaultValue={70} value={brush.flow} onChange={v => set({ brush: { ...useDevelop.getState().brush, flow: v } })} />
          <p className="dim small">[ and ] change size. Hold Alt to erase while painting.</p>
        </>
      )}
      {comp?.type === 'radial' && (
        <Slider label="Gradient Feather" min={0} max={100} defaultValue={50} value={comp.feather} onChange={v => updateComponent(mask.id, comp.id, c => { (c as any).feather = v; })} onCommit={commit} />
      )}
      {comp?.type === 'color' && (
        <>
          <SubHead>Color Range</SubHead>
          <div className="row mb8">
            <button className={`btn sm${tool === 'color-pick' ? ' active' : ''}`} onClick={() => useDevelop.getState().setTool('color-pick')}><Pipette size={12} />Pick colors</button>
            <span className="dim small">{comp.samples.length}/8 samples · Shift-click adds</span>
          </div>
          <Slider label="Refine" min={0} max={100} defaultValue={40} value={Math.round(comp.range * 100)} onChange={v => updateComponent(mask.id, comp.id, c => { (c as any).range = v / 100; })} onCommit={commit} title="How similar colors must be to be included" />
        </>
      )}
      {comp?.type === 'luminance' && (
        <>
          <SubHead>Luminance Range</SubHead>
          <LumRange mask={mask} comp={comp} />
          <button className={`btn sm mt8${tool === 'lum-pick' ? ' active' : ''}`} onClick={() => useDevelop.getState().setTool('lum-pick')}><Pipette size={12} />Pick a tone</button>
        </>
      )}
      {comp?.type === 'linear' && <p className="dim small">Drag the center line to move; drag the outer lines to change the transition. Drag on the photo to draw a new gradient.</p>}
      {comp?.type === 'radial' && <p className="dim small">Drag inside to move, the edge handles to resize, the top dot to rotate.</p>}
    </Section>
  );
}

function LumRange({ mask, comp }: { mask: Mask; comp: Extract<MaskComponent, { type: 'luminance' }> }) {
  const commit = () => useDevelop.getState().commit();
  return (
    <>
      <div className="lum-range" aria-hidden><div style={{ left: `${comp.min * 100}%`, width: `${(comp.max - comp.min) * 100}%` }} /></div>
      <Slider label="Min" min={0} max={100} defaultValue={65} value={Math.round(comp.min * 100)} gradient={G.lum} onChange={v => updateComponent(mask.id, comp.id, c => { (c as any).min = Math.min(v / 100, (c as any).max - 0.01); })} onCommit={commit} />
      <Slider label="Max" min={0} max={100} defaultValue={100} value={Math.round(comp.max * 100)} gradient={G.lum} onChange={v => updateComponent(mask.id, comp.id, c => { (c as any).max = Math.max(v / 100, (c as any).min + 0.01); })} onCommit={commit} />
      <Slider label="Smoothness" min={0} max={100} defaultValue={30} value={comp.feather} onChange={v => updateComponent(mask.id, comp.id, c => { (c as any).feather = v; })} onCommit={commit} />
    </>
  );
}

const LOCAL: { k: keyof LocalAdjustments; label: string; min?: number; max?: number; step?: number; gradient?: string; group: string }[] = [
  { k: 'temp', label: 'Temp', gradient: G.temp, group: 'Color' },
  { k: 'tint', label: 'Tint', gradient: G.tint, group: 'Color' },
  { k: 'hue', label: 'Hue', min: -180, max: 180, gradient: G.hue, group: 'Color' },
  { k: 'saturation', label: 'Saturation', gradient: G.sat, group: 'Color' },
  { k: 'vibrance', label: 'Vibrance', gradient: G.vib, group: 'Color' },
  { k: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01, group: 'Light' },
  { k: 'contrast', label: 'Contrast', group: 'Light' },
  { k: 'highlights', label: 'Highlights', group: 'Light' },
  { k: 'shadows', label: 'Shadows', group: 'Light' },
  { k: 'whites', label: 'Whites', group: 'Light' },
  { k: 'blacks', label: 'Blacks', group: 'Light' },
  { k: 'texture', label: 'Texture', group: 'Effects' },
  { k: 'clarity', label: 'Clarity', group: 'Effects' },
  { k: 'dehaze', label: 'Dehaze', group: 'Effects' },
  { k: 'sharpness', label: 'Sharpness', group: 'Detail' },
  { k: 'noise', label: 'Noise Reduction', min: 0, max: 100, group: 'Detail' },
];

function LocalAdjustPanel({ mask }: { mask: Mask }) {
  const commit = () => useDevelop.getState().commit();
  const groups = ['Light', 'Color', 'Effects', 'Detail'];
  return (
    <Section id="mask.adjust" title={`Adjust · ${mask.name}`} onReset={() => updateMask(mask.id, m => { m.adjust = defaultLocal(); }, 'Reset Mask Adjustments')}>
      {groups.map(g => (
        <React.Fragment key={g}>
          <SubHead>{g}</SubHead>
          {LOCAL.filter(l => l.group === g).map(l => (
            <Slider key={l.k} label={l.label} min={l.min ?? -100} max={l.max ?? 100} step={l.step ?? 1} defaultValue={0} gradient={l.gradient} value={mask.adjust[l.k]}
              format={l.k === 'exposure' ? v => `${v > 0 ? '+' : ''}${v.toFixed(2)}` : undefined}
              onChange={v => updateMask(mask.id, m => { m.adjust[l.k] = v; })} onCommit={commit} />
          ))}
          {g === 'Color' && <ColorOverlay mask={mask} />}
        </React.Fragment>
      ))}
    </Section>
  );
}

function ColorOverlay({ mask }: { mask: Mask }) {
  const commit = () => useDevelop.getState().commit();
  const { colorHue, colorSat } = mask.adjust;
  return (
    <div className="color-overlay">
      <div className="row between"><span className="slider-label">Color</span><span className="swatch" style={{ background: colorSat ? hueCss(colorHue, 0.7, 0.03 + colorSat / 100 * 0.15) : 'transparent' }} /></div>
      <Slider label="Overlay Hue" min={0} max={360} defaultValue={0} value={colorHue} gradient={G.hue} format={v => `${Math.round(v)}°`} onChange={v => updateMask(mask.id, m => { m.adjust.colorHue = v; })} onCommit={commit} />
      <Slider label="Overlay Amount" min={0} max={100} defaultValue={0} value={colorSat} onChange={v => updateMask(mask.id, m => { m.adjust.colorSat = v; })} onCommit={commit} />
    </div>
  );
}
