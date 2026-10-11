import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Wand2, Check, Save, RotateCcw, SlidersHorizontal, Columns3, Columns2, Square, X } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { SidePanel } from '../components/Panel';
import { Viewer } from '../develop/Viewer';
import { useEditorPhoto } from './Develop';
import { renderVersion } from './Compare';
import { Section, Slider, Seg, Empty, Progress, promptText } from '../components/ui';
import { Thumb } from '../components/Thumb';
import { reloadPresets } from '../develop/LeftPanels';
import { goWorkspace } from '../services/actions';
import { api } from '../api';
import {
  loadReferenceImage, fitGrade, gradedEdit, describeLook, QS,
  COLOR_ONLY_GROUPS, FULL_GROUPS, type ReferenceImage, type GradeResult, type LookStats,
} from '../analysis/referenceGrade';
import { cloneEdit, pickGroups, type EditParams, type SettingGroup } from '@shared/edit';
import type { Photo } from '@shared/types';

type Mode = 'color' | 'full';
type Layout = 'three' | 'two' | 'result';

/** 0–100 similarity scores between two looks (tone = quantiles, colour = zone casts + chroma). */
function matchScores(a: LookStats, b: LookStats) {
  const tone = QS.reduce((s, _, i) => s + Math.abs(a.q[i] - b.q[i]), 0) / QS.length;
  const cast = [0, 1, 2].reduce((s, z) => s + Math.hypot(a.zones[z].a - b.zones[z].a, a.zones[z].b - b.zones[z].b), 0) / 3;
  const chroma = Math.abs(a.chroma - b.chroma);
  return {
    tone: Math.round(100 * Math.max(0, 1 - tone / 0.25)),
    color: Math.round(100 * Math.max(0, 1 - (cast / 0.05 + chroma / 0.08) / 2)),
  };
}

export function ReferenceWorkspace() {
  const photo = useEditorPhoto();
  const photos = useLibrary(s => s.photos);
  const photoId = useDevelop(s => s.photoId);
  const [ref, setRef] = useState<ReferenceImage | null>(null);
  const [refBusy, setRefBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('full');
  const [strength, setStrength] = useState(100);
  const [layout, setLayout] = useState<Layout>('three');
  const [fit, setFit] = useState<{ result: GradeResult; mode: Mode; base: EditParams } | null>(null);
  const [fitting, setFitting] = useState(false);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const run = useRef(0);
  const toast = useApp(s => s.toast);

  const loaded = photo != null && photoId === photo.id;

  // A different photo: drop the fit, keep the reference
  useEffect(() => { setFit(null); setApplied(false); setOriginalUrl(null); useDevelop.getState().setPreview(null); }, [photo?.id]);
  useEffect(() => () => useDevelop.getState().setPreview(null), []);

  const chooseReference = useCallback(async (src: { kind: 'file'; path: string } | { kind: 'photo'; photo: Photo }) => {
    setRefBusy(true);
    try {
      setRef(await loadReferenceImage(src));
      setFit(null); setApplied(false);
    } catch (err: any) {
      toast({ kind: 'error', title: 'Could not read the reference image', body: String(err?.message ?? err) });
    } finally { setRefBusy(false); }
  }, [toast]);

  useEffect(() => {
    const onDrop = (e: Event) => chooseReference({ kind: 'file', path: (e as CustomEvent<string>).detail });
    window.addEventListener('photostudio:reference-drop', onDrop);
    return () => window.removeEventListener('photostudio:reference-drop', onDrop);
  }, [chooseReference]);

  const preview = useCallback((f: typeof fit, s: number) => {
    if (!f) return;
    useDevelop.getState().setPreview(gradedEdit(f.base, f.result.edit, s / 100, f.mode), 'Reference Grade');
  }, []);

  // Fit whenever reference, photo or mode changes (closed-loop analysis runs on the offscreen GPU renderer, on-device)
  useEffect(() => {
    if (!ref || !photo || !loaded || applied) return;
    const id = ++run.current;
    const base = cloneEdit(useDevelop.getState().edit);
    setFitting(true);
    if (!originalUrl) renderVersion(photo, base).then(u => { if (run.current === id) setOriginalUrl(u); }).catch(() => {});
    fitGrade(photo, base, ref.stats, mode).then(result => {
      if (run.current !== id) return;
      const f = { result, mode, base };
      setFit(f);
      preview(f, strength);
    }).catch(err => {
      if (run.current === id) toast({ kind: 'error', title: 'Reference grade failed', body: String(err?.message ?? err) });
    }).finally(() => { if (run.current === id) setFitting(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, photo?.id, loaded, mode, applied]);

  const graded = useMemo(() => fit ? gradedEdit(fit.base, fit.result.edit, strength / 100, fit.mode) : null, [fit, strength]);

  const apply = () => {
    if (!graded || !ref) return;
    const dev = useDevelop.getState();
    dev.setPreview(null);
    dev.replaceEdit(graded, `Reference Grade (${mode === 'color' ? 'Color Only' : 'Full Grade'} ${strength}%)`, { presetName: `Reference: ${ref.label}` });
    setApplied(true);
    toast({ kind: 'success', title: 'Reference grade applied', body: 'Every adjustment is editable in Develop and can be undone from History.' });
  };

  const revert = () => { useDevelop.getState().setPreview(null); setFit(null); setApplied(false); setStrength(100); };

  const saveAsPreset = async () => {
    if (!graded || !ref) return;
    const name = await promptText('Save reference grade as preset', `Look – ${ref.label.replace(/\.[^.]+$/, '')}`, { label: 'Preset name', okLabel: 'Save preset' });
    if (!name) return;
    // Exposure is specific to the photo it was fitted on, so a preset carries curve and colour only.
    const groups: SettingGroup[] = mode === 'color' ? [...COLOR_ONLY_GROUPS] : FULL_GROUPS.filter(g => g !== 'tone');
    await api.savePreset({
      id: `ref-${crypto.randomUUID()}`, name, folder: 'Reference Grades', favorite: false, builtin: false,
      groups, settings: pickGroups(graded, groups), createdAt: new Date().toISOString(),
      source: { kind: 'reference-grade', note: `Matched to ${ref.label}: ${describeLook(ref.stats).join(', ')} (${mode === 'color' ? 'Color Only' : 'Full Grade'}, ${strength}%)` },
    });
    await reloadPresets();
    toast({ kind: 'success', title: `Saved preset “${name}”`, body: 'Find it under Presets › Reference Grades.' });
  };

  if (!photos.length) {
    return <div className="center"><Empty kind="reference" title="No photos to grade"><p>Import photos in the Library first.</p><button className="btn primary" onClick={() => goWorkspace('library')}>Go to Library</button></Empty></div>;
  }

  const before = fit ? matchScores(fit.result.target, ref!.stats) : null;
  const after = fit ? matchScores(fit.result.result, ref!.stats) : null;

  return (
    <>
      <SidePanel side="left">
        <Section id="ref.source" title="Reference image">
          {ref ? (
            <div className="ref-current">
              <img src={ref.url} alt="Reference" />
              <div className="row"><span className="text-0 grow ellipsis" title={ref.label}>{ref.label}</span>
                <button className="icon-btn" title="Remove reference" onClick={() => { setRef(null); revert(); }}><X size={13} /></button></div>
            </div>
          ) : (
            <div className="ref-drop" onClick={async () => { const p = await api.pickImage(); if (p) chooseReference({ kind: 'file', path: p }); }} role="button" tabIndex={0}>
              {refBusy ? <Progress indeterminate /> : <><ImagePlus size={22} /><span>Drop a reference image here</span><span className="text-1">or click to choose a file (JPEG, PNG, TIFF, WebP, HEIC or RAW)</span></>}
            </div>
          )}
          {ref && <button className="btn sm" onClick={async () => { const p = await api.pickImage(); if (p) chooseReference({ kind: 'file', path: p }); }}><ImagePlus size={12} />Choose another…</button>}
          <p className="text-1 small">References are analysed on this device and are never uploaded.</p>
        </Section>
        <Section id="ref.catalog" title="Or use a catalog photo" defaultOpen={!ref}>
          <div className="ref-catalog">
            {photos.filter(p => p.id !== photo?.id).slice(0, 120).map(p => (
              <div key={p.id} className={`ref-cat${ref?.source.kind === 'photo' && ref.source.id === p.id ? ' active' : ''}`} title={`Use ${p.filename} (with its edits) as the reference`} onClick={() => chooseReference({ kind: 'photo', photo: p })} role="button"><Thumb photo={p} /></div>
            ))}
          </div>
        </Section>
        {ref && (
          <Section id="ref.analysis" title="Reference look">
            <div className="palette">{ref.stats.palette.map((c, i) => <span key={i} style={{ background: c.hex, flex: Math.max(0.08, c.share) }} title={`${c.hex} · ${Math.round(c.share * 100)}%`} />)}</div>
            <div className="tag-list">{describeLook(ref.stats).map(t => <span key={t} className="badge">{t}</span>)}</div>
            {fit && <>
              <div className="sub-head">This photo now</div>
              <div className="tag-list">{describeLook(fit.result.target).map(t => <span key={t} className="badge muted">{t}</span>)}</div>
            </>}
          </Section>
        )}
      </SidePanel>

      <div className="center">
        <div className={`ref-stage ${layout}`}>
          {layout !== 'result' && (
            <div className="ref-pane">
              <div className="ref-pane-title">Reference</div>
              {ref ? <img src={ref.url} alt="Reference" /> : <div className="panel-empty">No reference yet</div>}
            </div>
          )}
          {layout === 'three' && (
            <div className="ref-pane">
              <div className="ref-pane-title">Original</div>
              {originalUrl ? <img src={originalUrl} alt="Original" /> : <div className="panel-empty">{fitting ? <Progress indeterminate /> : 'Your photo before grading'}</div>}
            </div>
          )}
          <div className="ref-pane result">
            <div className="ref-pane-title">Result{fit && !applied && <span className="accent"> · preview {strength}%</span>}{applied && <span className="ok"> · applied</span>}</div>
            <Viewer photo={photo} hud={layout === 'result'} />
          </div>
        </div>
        {!ref && <div className="ref-hint"><Wand2 size={14} />Choose a reference image on the left to match its look.</div>}
      </div>

      <SidePanel side="right" header={
        <div className="toolstrip">
          <Seg<Layout> value={layout} onChange={setLayout} options={[
            { value: 'three', label: <Columns3 size={13} />, title: 'Reference | Original | Result' },
            { value: 'two', label: <Columns2 size={13} />, title: 'Reference | Result' },
            { value: 'result', label: <Square size={13} />, title: 'Result only' },
          ]} />
        </div>
      }>
        <Section id="ref.grade" title="Reference Grade" badge={fitting ? <span className="badge ai">Analysing…</span> : undefined}>
          <Seg<Mode> full value={mode} onChange={m => { setMode(m); setApplied(false); }} options={[
            { value: 'color', label: 'Color Only', title: 'Match colour, saturation and split toning; keep your exposure and contrast' },
            { value: 'full', label: 'Full Grade', title: 'Also match exposure, contrast and the tone curve' },
          ]} />
          <Slider label="Strength" min={0} max={150} defaultValue={100} value={strength} format={v => `${Math.round(v)}%`}
            disabled={!fit || applied} onChange={v => { setStrength(v); preview(fit, v); }} />
          {fitting && <Progress indeterminate />}
          {!ref && <p className="text-1 small">Add a reference to start.</p>}
          {before && after && (
            <div className="match-table">
              <div /><div className="text-1">Before</div><div className="text-1">Fitted</div>
              <div>Tone match</div><div>{before.tone}%</div><div className="accent">{after.tone}%</div>
              <div>Color match</div><div>{before.color}%</div><div className="accent">{after.color}%</div>
            </div>
          )}
          {fit && fit.result.notes.length > 0 && <p className="text-1 small">Adjusted: {fit.result.notes.join(', ')}.</p>}
          <div className="col">
            <button className="btn primary" disabled={!graded || applied || fitting} onClick={apply}><Check size={13} />Apply to photo</button>
            <button className="btn" disabled={!graded} onClick={saveAsPreset}><Save size={13} />Save as preset…</button>
            <button className="btn" disabled={!graded} onClick={() => { if (!applied) apply(); goWorkspace('develop'); }}><SlidersHorizontal size={13} />Fine-tune in Develop</button>
            {(fit || applied) && <button className="btn ghost" onClick={revert}><RotateCcw size={13} />{applied ? 'Grade again' : 'Discard preview'}</button>}
          </div>
        </Section>
        {graded && fit && <FittedValues base={fit.base} graded={graded} mode={mode} />}
      </SidePanel>
    </>
  );
}

/** Shows the concrete slider values the grade produces, so nothing is a black box. */
function FittedValues({ base, graded, mode }: { base: EditParams; graded: EditParams; mode: Mode }) {
  const rows: [string, string][] = [];
  const d = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
  if (mode === 'full' && graded.exposure !== base.exposure) rows.push(['Exposure', d(graded.exposure, 2)]);
  if (mode === 'full') rows.push(['Tone curve', `${graded.curve.rgb.length} points`]);
  if (graded.vibrance !== base.vibrance) rows.push(['Vibrance', d(graded.vibrance)]);
  if (graded.saturation !== base.saturation) rows.push(['Saturation', d(graded.saturation)]);
  (['shadows', 'midtones', 'highlights'] as const).forEach(k => {
    const w = graded.grading[k];
    if (w.sat > 0.5) rows.push([`Grading ${k}`, `${Math.round(w.hue)}° / ${w.sat.toFixed(0)}`]);
  });
  const hslChanged = Object.entries(graded.hsl).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((base.hsl as any)[k])).length;
  if (hslChanged) rows.push(['Color mixer', `${hslChanged} channel${hslChanged === 1 ? '' : 's'}`]);
  return (
    <Section id="ref.values" title="Fitted settings" defaultOpen={false}>
      <div className="kv">{rows.map(([k, v]) => <React.Fragment key={k}><span className="text-1">{k}</span><span>{v}</span></React.Fragment>)}</div>
      <p className="text-1 small">These are ordinary PhotoStudio settings. After applying, every one can be changed in Develop.</p>
    </Section>
  );
}
