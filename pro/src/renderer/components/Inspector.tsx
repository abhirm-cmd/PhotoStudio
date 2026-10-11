/** Clip inspector: transform, opacity, speed, fades, transitions, titles, mattes and audio level. */
import React from 'react';
import { FlipHorizontal2, FlipVertical2, Palette, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { type Clip, type Project, type TitleSpec, clipEnd, timecode, defaultTransform } from '@shared/project';
import { withLinked } from '@shared/timeline';
import { isNeutral } from '@shared/grade';
import { useProject } from '../store/project';
import { useUI } from '../store/ui';
import { Slider, Section, Seg, Empty } from './ui';
import * as A from '../services/actions';

const FONTS = ['Inter Variable', 'Georgia', 'Times New Roman', 'Arial', 'Helvetica', 'Courier New', 'Impact', 'Trebuchet MS', 'Verdana'];

function useClipEdit(c: Clip) {
  const edit = useProject(s => s.edit);
  return (label: string, fn: (x: Clip, p: Project) => void, key?: string) =>
    edit(label, p => { const x = p.clips.find(k => k.id === c.id); if (x) fn(x, p); }, key ? `${key}:${c.id}` : undefined);
}

export function Inspector() {
  const p = useProject(s => s.project);
  const selection = useProject(s => s.selection);
  const sel = p.clips.filter(c => selection.includes(c.id));
  if (!sel.length) return (
    <div className="inspector">
      <div className="panel-title">Inspector</div>
      <Empty kind="timeline" title="Nothing selected" small><p>Select a clip on the timeline to adjust its position, size, speed, fades, transitions and level.</p></Empty>
      <ProjectSettings />
    </div>
  );
  // With a linked pair selected, show the video part first and the audio part's level below
  const vids = sel.filter(c => p.tracks.find(t => t.id === c.trackId)?.kind === 'video');
  const auds = sel.filter(c => p.tracks.find(t => t.id === c.trackId)?.kind === 'audio');
  const main = vids[0] ?? auds[0];
  const linkedAudio = auds.find(a => a.linkId && a.linkId === main.linkId) ?? (vids.length ? undefined : auds[0]);
  const many = withLinked(p, [main.id]).length < sel.length;
  return (
    <div className="inspector" data-testid="inspector">
      <div className="panel-title">Inspector{many && <span className="dim small"> · {sel.length} clips selected (editing {main.name})</span>}</div>
      <div className="panel-scroll">
        <ClipSection c={main} p={p} />
        {vids.includes(main) && main.kind === 'title' && <TitleSection c={main} />}
        {vids.includes(main) && main.kind === 'color' && <MatteSection c={main} />}
        {vids.includes(main) && <MotionSection c={main} />}
        {vids.includes(main) && <TransitionSection c={main} p={p} />}
        {vids.includes(main) && main.kind === 'media' && <GradeLink c={main} />}
        {(linkedAudio || auds.includes(main)) && <AudioSection c={linkedAudio ?? main} />}
      </div>
    </div>
  );
}

function ClipSection({ c, p }: { c: Clip; p: Project }) {
  const set = useClipEdit(c);
  const fps = p.settings.fps;
  const m = p.media.find(x => x.id === c.mediaId);
  return (
    <Section id="i-clip" title="Clip">
      <div className="field"><label>Name</label><input className="input" value={c.name} onChange={e => set('Rename clip', x => { x.name = e.target.value; }, 'name')} /></div>
      <dl className="kv">
        <dt>Start</dt><dd>{timecode(c.start, fps)}</dd>
        <dt>End</dt><dd>{timecode(clipEnd(c), fps)}</dd>
        <dt>Duration</dt><dd>{timecode(c.duration, fps)}</dd>
        {m && <><dt>Source</dt><dd title={m.path}>{m.name}</dd><dt>Source in</dt><dd>{c.srcIn.toFixed(2)} s</dd></>}
      </dl>
      {c.kind === 'media' && m?.kind !== 'image' && (
        <Slider label="Speed" value={Math.round(c.speed * 100)} min={10} max={400} step={1} defaultValue={100} format={v => `${Math.round(v)}%`}
          onChange={v => A.setSpeed([c.id], v / 100, `speed:${c.id}`)} />
      )}
      <label className="check"><input type="checkbox" checked={c.enabled} onChange={() => set(c.enabled ? 'Disable clip' : 'Enable clip', x => { for (const id of [x.id]) x.enabled = !c.enabled; })} />Enabled</label>
    </Section>
  );
}

function MotionSection({ c }: { c: Clip }) {
  const set = useClipEdit(c);
  const t = c.transform;
  const tf = (label: string, patch: Partial<Clip['transform']>, key: string) => set(label, x => Object.assign(x.transform, patch), key);
  const fps = useProject(s => s.project.settings.fps);
  return (
    <Section id="i-motion" title="Motion & opacity" onReset={() => set('Reset motion', x => { x.transform = defaultTransform(); x.opacity = 1; })}>
      <Slider label="Scale" value={Math.round(t.scale * 100)} min={5} max={400} defaultValue={100} format={v => `${Math.round(v)}%`} onChange={v => tf('Scale', { scale: v / 100 }, 'scale')} />
      <Slider label="Position X" value={t.x} min={-2000} max={2000} defaultValue={0} onChange={v => tf('Position', { x: v }, 'px')} />
      <Slider label="Position Y" value={t.y} min={-2000} max={2000} defaultValue={0} onChange={v => tf('Position', { y: v }, 'py')} />
      <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={0.5} defaultValue={0} format={v => `${v.toFixed(1)}°`} onChange={v => tf('Rotation', { rotation: v }, 'rot')} />
      <div className="subhead">Crop</div>
      <Slider label="Left" value={Math.round(t.cropL * 100)} min={0} max={90} defaultValue={0} format={v => `${Math.round(v)}%`} onChange={v => tf('Crop', { cropL: Math.min(v / 100, 0.95 - t.cropR) }, 'cl')} />
      <Slider label="Right" value={Math.round(t.cropR * 100)} min={0} max={90} defaultValue={0} format={v => `${Math.round(v)}%`} onChange={v => tf('Crop', { cropR: Math.min(v / 100, 0.95 - t.cropL) }, 'cr')} />
      <Slider label="Top" value={Math.round(t.cropT * 100)} min={0} max={90} defaultValue={0} format={v => `${Math.round(v)}%`} onChange={v => tf('Crop', { cropT: Math.min(v / 100, 0.95 - t.cropB) }, 'ct')} />
      <Slider label="Bottom" value={Math.round(t.cropB * 100)} min={0} max={90} defaultValue={0} format={v => `${Math.round(v)}%`} onChange={v => tf('Crop', { cropB: Math.min(v / 100, 0.95 - t.cropT) }, 'cb')} />
      <div className="btn-row mt8">
        <button className={`btn sm${t.flipH ? ' active' : ''}`} onClick={() => tf('Flip', { flipH: !t.flipH }, '')}><FlipHorizontal2 size={13} />Flip H</button>
        <button className={`btn sm${t.flipV ? ' active' : ''}`} onClick={() => tf('Flip', { flipV: !t.flipV }, '')}><FlipVertical2 size={13} />Flip V</button>
      </div>
      <div className="subhead">Opacity & fades</div>
      <Slider label="Opacity" value={Math.round(c.opacity * 100)} min={0} max={100} defaultValue={100} format={v => `${Math.round(v)}%`} onChange={v => set('Opacity', x => { x.opacity = v / 100; }, 'op')} />
      <Slider label="Fade in" value={c.fadeIn / fps} min={0} max={Math.min(10, c.duration / fps)} step={0.05} defaultValue={0} format={v => `${v.toFixed(2)} s`} onChange={v => set('Fade in', x => { x.fadeIn = Math.round(v * fps); }, 'fi')} />
      <Slider label="Fade out" value={c.fadeOut / fps} min={0} max={Math.min(10, c.duration / fps)} step={0.05} defaultValue={0} format={v => `${v.toFixed(2)} s`} onChange={v => set('Fade out', x => { x.fadeOut = Math.round(v * fps); }, 'fo')} />
    </Section>
  );
}

function TransitionSection({ c, p }: { c: Clip; p: Project }) {
  const set = useClipEdit(c);
  const fps = p.settings.fps;
  const tr = c.transitionIn;
  const prev = p.clips.find(x => x.trackId === c.trackId && clipEnd(x) === c.start);
  return (
    <Section id="i-tr" title="Transition in">
      <Seg value={tr?.type ?? 'none'} full options={[{ value: 'none', label: 'None' }, { value: 'dissolve', label: 'Dissolve' }, { value: 'dip', label: 'Dip to black' }, { value: 'slide', label: 'Slide' }]}
        onChange={v => A.setTransition(v === 'none' ? null : v, [c.id])} />
      {tr && <Slider label="Duration" value={tr.duration / fps} min={0.1} max={Math.max(0.2, Math.min(5, c.duration / fps))} step={0.05} defaultValue={1} format={v => `${v.toFixed(2)} s`}
        onChange={v => set('Transition length', x => { if (x.transitionIn) x.transitionIn.duration = Math.max(2, Math.round(v * fps)); }, 'trd')} />}
      {tr && (tr.type === 'dissolve' || tr.type === 'slide') && !prev && <p className="dim small">No clip ends right before this one on the track, so this {tr.type === 'dissolve' ? 'fades in over whatever is below' : 'slides in over the tracks below'}.</p>}
      {tr && prev && tr.type !== 'dip' && <p className="dim small">Blends from “{prev.name}”, whose last frame is held if its media runs out.</p>}
    </Section>
  );
}

function GradeLink({ c }: { c: Clip }) {
  const graded = !isNeutral(c.grade);
  return (
    <Section id="i-grade" title="Color">
      <div className="row"><span className={graded ? '' : 'dim'}>{graded ? 'This clip has a grade.' : 'No grade applied.'}</span><span className="grow" /><button className="btn sm" onClick={() => useUI.getState().setPage('color')}><Palette size={13} />Open Color</button></div>
    </Section>
  );
}

function AudioSection({ c }: { c: Clip }) {
  const set = useClipEdit(c);
  const fps = useProject(s => s.project.settings.fps);
  return (
    <Section id="i-audio" title="Audio">
      <Slider label="Clip volume" value={c.volume} min={-40} max={12} step={0.1} defaultValue={0} format={v => (v <= -40 ? '−∞ dB' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`)}
        onChange={v => set('Clip volume', x => { x.volume = v <= -40 ? -60 : v; }, 'vol')} />
      <Slider label="Fade in" value={c.fadeIn / fps} min={0} max={Math.min(10, c.duration / fps)} step={0.05} defaultValue={0} format={v => `${v.toFixed(2)} s`} onChange={v => set('Audio fade in', x => { x.fadeIn = Math.round(v * fps); }, 'afi')} />
      <Slider label="Fade out" value={c.fadeOut / fps} min={0} max={Math.min(10, c.duration / fps)} step={0.05} defaultValue={0} format={v => `${v.toFixed(2)} s`} onChange={v => set('Audio fade out', x => { x.fadeOut = Math.round(v * fps); }, 'afo')} />
    </Section>
  );
}

function TitleSection({ c }: { c: Clip }) {
  const set = useClipEdit(c);
  const t = c.title!;
  const tt = (label: string, patch: Partial<TitleSpec>, key: string) => set(label, x => { Object.assign(x.title!, patch); if (patch.text != null) x.name = patch.text.split('\n')[0] || 'Title'; }, key);
  return (
    <Section id="i-title" title="Title">
      <div className="field"><label>Text</label><textarea className="input" rows={3} value={t.text} onChange={e => tt('Title text', { text: e.target.value }, 'txt')} data-testid="title-text" /></div>
      <div className="field-row"><label>Font</label>
        <select className="input sm" value={t.font} onChange={e => tt('Title font', { font: e.target.value }, '')}>{FONTS.map(f => <option key={f} value={f}>{f.replace(' Variable', '')}</option>)}</select>
      </div>
      <Slider label="Size" value={t.size} min={12} max={400} defaultValue={96} format={v => `${Math.round(v)} px`} onChange={v => tt('Title size', { size: v }, 'sz')} />
      <Slider label="Weight" value={t.weight} min={100} max={900} step={100} defaultValue={700} onChange={v => tt('Title weight', { weight: v }, 'wt')} />
      <div className="field-row"><label>Color</label><input type="color" value={t.color} onChange={e => tt('Title color', { color: e.target.value }, 'col')} /><span className="grow" />
        <Seg value={t.align} options={[{ value: 'left', label: <AlignLeft size={12} /> }, { value: 'center', label: <AlignCenter size={12} /> }, { value: 'right', label: <AlignRight size={12} /> }]} onChange={v => tt('Title align', { align: v }, '')} />
      </div>
      <Slider label="Position X" value={Math.round(t.x * 100)} min={0} max={100} defaultValue={50} format={v => `${Math.round(v)}%`} onChange={v => tt('Title position', { x: v / 100 }, 'tx')} />
      <Slider label="Position Y" value={Math.round(t.y * 100)} min={0} max={100} defaultValue={50} format={v => `${Math.round(v)}%`} onChange={v => tt('Title position', { y: v / 100 }, 'ty')} />
      <label className="check"><input type="checkbox" checked={t.shadow} onChange={() => tt('Title shadow', { shadow: !t.shadow }, '')} />Drop shadow</label>
      <label className="check"><input type="checkbox" checked={t.box} onChange={() => tt('Title background', { box: !t.box }, '')} />Background box</label>
      {t.box && <>
        <div className="field-row"><label>Box color</label><input type="color" value={t.boxColor} onChange={e => tt('Box color', { boxColor: e.target.value }, 'bc')} /></div>
        <Slider label="Box opacity" value={Math.round(t.boxOpacity * 100)} min={0} max={100} defaultValue={50} format={v => `${Math.round(v)}%`} onChange={v => tt('Box opacity', { boxOpacity: v / 100 }, 'bo')} />
      </>}
    </Section>
  );
}

function MatteSection({ c }: { c: Clip }) {
  const set = useClipEdit(c);
  return (
    <Section id="i-matte" title="Color matte">
      <div className="field-row"><label>Color</label><input type="color" value={c.color ?? '#000000'} onChange={e => set('Matte color', x => { x.color = e.target.value; }, 'mc')} /></div>
    </Section>
  );
}

const PRESETS = [
  { label: '4K UHD', w: 3840, h: 2160 }, { label: '1080p HD', w: 1920, h: 1080 }, { label: '720p HD', w: 1280, h: 720 },
  { label: 'Vertical 1080×1920', w: 1080, h: 1920 }, { label: 'Square 1080', w: 1080, h: 1080 }, { label: 'DCI 2K', w: 2048, h: 1080 },
];

export function ProjectSettings() {
  const s = useProject(st => st.project.settings);
  const edit = useProject(st => st.edit);
  const cur = PRESETS.find(x => x.w === s.width && x.h === s.height);
  return (
    <Section id="i-proj" title="Sequence settings">
      <div className="field"><label>Frame size</label>
        <select className="input" value={cur ? `${cur.w}x${cur.h}` : 'custom'} onChange={e => { const [w, h] = e.target.value.split('x').map(Number); if (w) edit('Frame size', p => { p.settings.width = w; p.settings.height = h; }); }}>
          {PRESETS.map(x => <option key={x.label} value={`${x.w}x${x.h}`}>{x.label} ({x.w}×{x.h})</option>)}
          {!cur && <option value="custom">Custom ({s.width}×{s.height})</option>}
        </select>
      </div>
      <div className="field"><label>Frame rate</label>
        <select className="input" value={s.fps} onChange={e => {
          const fps = Number(e.target.value);
          // Keep every clip at the same time position when the timebase changes
          edit('Frame rate', p => { const k = fps / p.settings.fps; for (const c of p.clips) { c.start = Math.round(c.start * k); c.duration = Math.max(1, Math.round(c.duration * k)); c.fadeIn = Math.round(c.fadeIn * k); c.fadeOut = Math.round(c.fadeOut * k); if (c.transitionIn) c.transitionIn.duration = Math.max(2, Math.round(c.transitionIn.duration * k)); } for (const m of p.markers) m.frame = Math.round(m.frame * k); if (p.inPoint != null) p.inPoint = Math.round(p.inPoint * k); if (p.outPoint != null) p.outPoint = Math.round(p.outPoint * k); p.settings.fps = fps; });
        }}>
          {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map(f => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </div>
      <p className="dim small">Timeline positions are whole frames; changing the frame rate rescales them so clips keep their timing.</p>
    </Section>
  );
}
