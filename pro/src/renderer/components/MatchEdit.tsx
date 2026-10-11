/**
 * Match Edit dialog: pick an already edited reference video and new footage;
 * the reference is analysed on this computer (cuts, dissolves, dips, fades,
 * zoom/pan moves, look) and the same edit is rebuilt on the timeline.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Wand2, Film, Image as ImageIcon, FolderInput, ArrowRightLeft, ZoomIn, Check } from 'lucide-react';
import { Modal, Seg, Progress, confirmDialog } from './ui';
import { api } from '../api';
import { useProject, P } from '../store/project';
import { usePlayer } from '../store/player';
import { toast } from '../store/ui';
import { importPaths } from '../services/media';
import { buildMatchEdit, describeAnalysis, fitLook, v1Clips, type MatchOptions, type RefAnalysis } from '@shared/matchedit';
import { newProject, type MediaItem } from '@shared/project';

export const useMatchEdit = create<{ open: boolean; setOpen(v: boolean): void }>(set => ({ open: false, setOpen: open => set({ open }) }));

/** Analyses are kept for the session (keyed by file and size) so reopening the dialog is instant. */
const cache = new Map<string, RefAnalysis>();
const keyOf = (m: MediaItem) => `${m.path}|${m.size}`;

export async function analyzeMedia(m: MediaItem, onProgress?: (f: number) => void): Promise<RefAnalysis> {
  const hit = cache.get(keyOf(m));
  if (hit) return hit;
  const jobId = `match_${Date.now()}`;
  const off = api.on('match:progress', (e: { jobId: string; progress: number }) => { if (e.jobId === jobId) onProgress?.(e.progress); });
  try {
    const a = await api.analyzeReference(jobId, m.path);
    cache.set(keyOf(m), a);
    return a;
  } finally { off(); }
}

export interface MatchRequest extends MatchOptions { referenceId: string; footageIds: string[]; adoptFormat: boolean }

/** Build the matched edit into the project (one undo step). Returns the number of shots placed. */
export async function runMatchEdit(req: MatchRequest, onStatus?: (s: string) => void): Promise<number> {
  const p0 = P();
  const ref = p0.media.find(m => m.id === req.referenceId);
  if (!ref) throw new Error('Choose a reference video.');
  const footage = req.footageIds.map(id => p0.media.find(m => m.id === id)).filter((m): m is MediaItem => !!m);
  if (!footage.length) throw new Error('Choose at least one clip of new footage.');
  onStatus?.('Analysing the reference…');
  const a = await analyzeMedia(ref);
  const settings = req.adoptFormat && a.width && a.height ? { ...p0.settings, width: a.width, height: a.height, fps: Math.round(a.fps * 1000) / 1000 } : p0.settings;
  let look = null;
  if (req.color && a.colors.length) {
    onStatus?.('Matching the look…');
    // plan once without a grade to know which parts of the footage get used, then sample those
    const trial = { ...newProject(), settings, media: p0.media.map(m => ({ ...m })) };
    buildMatchEdit(trial, ref, a, footage, { ...req, color: false }, null);
    const samples: number[] = [];
    for (const m of footage) {
      const times = v1Clips(trial).filter(c => c.mediaId === m.id).map(c => c.srcIn + c.duration / settings.fps / 2);
      if (times.length) samples.push(...(await api.sampleColors(m.path, times.slice(0, 24), m.kind === 'image')));
    }
    if (samples.length) look = fitLook(a.colors, samples);
  }
  let made = 0;
  useProject.getState().edit('Match Edit', p => {
    p.settings = { ...settings };
    made = buildMatchEdit(p, ref, a, footage, req, look);
  });
  usePlayer.getState().setFrame(0);
  return made;
}

/* ------------------------------------------------------------------ UI */

const pickable = (m: MediaItem) => !m.missing && (m.kind === 'video' || m.kind === 'image');

export function MatchEditDialog() {
  const open = useMatchEdit(s => s.open);
  if (!open) return null;
  return <Dialog onClose={() => useMatchEdit.getState().setOpen(false)} />;
}

function Dialog({ onClose }: { onClose(): void }) {
  const media = useProject(s => s.project.media);
  const hasClips = useProject(s => s.project.clips.length > 0);
  const settings = useProject(s => s.project.settings);
  const videos = media.filter(m => !m.missing && m.kind === 'video');
  const [refId, setRefId] = useState<string>(() => videos[0]?.id ?? '');
  const [footage, setFootage] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<RefAnalysis | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opts, setOpts] = useState({ motion: true, color: true, fill: true, adoptFormat: !hasClips, audio: 'reference' as MatchOptions['audio'] });
  const ref = media.find(m => m.id === refId);

  useEffect(() => {
    setAnalysis(null); setError(null);
    if (!ref) return;
    let live = true;
    setProgress(0);
    analyzeMedia(ref, f => live && setProgress(f))
      .then(a => { if (live) { setAnalysis(a); setProgress(null); if (!a.hasAudio) setOpts(o => ({ ...o, audio: o.audio === 'reference' ? 'footage' : o.audio })); } })
      .catch(e => { if (live) { setError(String(e?.message ?? e)); setProgress(null); } });
    return () => { live = false; };
  }, [refId]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = media.filter(m => pickable(m) && m.id !== refId);
  const toggle = (id: string) => setFootage(f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]));

  const importInto = async (as: 'reference' | 'footage') => {
    const paths = await api.pickMedia('files');
    if (!paths.length) return;
    await importPaths(paths);
    const items = P().media.filter(m => paths.includes(m.path));
    if (as === 'reference') { const v = items.find(m => m.kind === 'video'); if (v) { setRefId(v.id); setFootage(f => f.filter(x => x !== v.id)); } }
    else setFootage(f => [...f, ...items.filter(m => pickable(m) && m.id !== refId && !f.includes(m.id)).map(m => m.id)]);
  };

  const build = async () => {
    if (!analysis) return;
    if (P().clips.length && !(await confirmDialog('Replace the timeline with the matched edit?', 'Match Edit rebuilds the whole timeline from your footage. You can undo it with Ctrl+Z.', { okLabel: 'Build edit' }))) return;
    setBusy('Building…');
    try {
      const n = await runMatchEdit({ ...opts, referenceId: refId, footageIds: footage }, setBusy);
      toast({ kind: 'success', title: `Matched ${n} shot${n === 1 ? '' : 's'} to ${ref?.name}`, body: 'Every cut, transition and move is a normal clip setting you can change.' });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally { setBusy(null); }
  };

  const fmt = analysis && analysis.width ? `${analysis.width}×${analysis.height} · ${Math.round(analysis.fps * 100) / 100} fps` : '';
  const sameFormat = analysis ? analysis.width === settings.width && analysis.height === settings.height && Math.abs(analysis.fps - settings.fps) < 0.01 : true;

  return (
    <Modal title="Match Edit" wide icon={<Wand2 size={16} />} onClose={onClose} footer={<>
      <span className="dim small grow">Analysis runs on this computer. Nothing is uploaded.</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!analysis || !footage.length || !!busy} onClick={build} data-testid="match-build">{busy ?? 'Build edit'}</button>
    </>}>
      <div className="match-edit">
        <p className="dim small">Use an edit you like as a template. Its cuts, shot lengths, transitions, fades and zoom/pan moves are copied onto your new footage, and its look can be matched too.</p>

        <div className="field">
          <label>Reference edit</label>
          <div className="row">
            <select className="input grow" value={refId} onChange={e => { setRefId(e.target.value); setFootage(f => f.filter(x => x !== e.target.value)); }} data-testid="match-reference">
              {!videos.length && <option value="">Import a video first</option>}
              {videos.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button className="btn sm" onClick={() => importInto('reference')}><FolderInput size={13} />Import…</button>
          </div>
        </div>

        <div className="match-analysis">
          {progress !== null && <div className="row"><span className="dim small">Finding cuts and moves…</span><Progress value={progress} total={1} /></div>}
          {error && <div className="notice warn">{error}</div>}
          {analysis && <>
            <div className="small" data-testid="match-summary">{describeAnalysis(analysis)}</div>
            <ShotStrip a={analysis} />
          </>}
        </div>

        <div className="field">
          <label>New footage <span className="dim">(used in the order you tick them)</span></label>
          <div className="match-footage" data-testid="match-footage">
            {!candidates.length && <div className="dim small">Import the clips you want to edit.</div>}
            {candidates.map(m => {
              const i = footage.indexOf(m.id);
              return (
                <label key={m.id} className={`match-item${i >= 0 ? ' on' : ''}`}>
                  <input type="checkbox" checked={i >= 0} onChange={() => toggle(m.id)} />
                  <span className="match-num">{i >= 0 ? i + 1 : ''}</span>
                  {m.kind === 'image' ? <ImageIcon size={13} /> : <Film size={13} />}
                  <span className="nm">{m.name}</span>
                  <span className="dim small">{m.kind === 'image' ? 'still' : `${m.duration.toFixed(1)} s`}</span>
                </label>
              );
            })}
          </div>
          <div className="row"><button className="btn sm ghost" onClick={() => importInto('footage')}><FolderInput size={13} />Import footage…</button></div>
        </div>

        <div className="match-options">
          <label className="check"><input type="checkbox" checked={opts.motion} onChange={e => setOpts({ ...opts, motion: e.target.checked })} />Copy zoom and pan moves</label>
          <label className="check"><input type="checkbox" checked={opts.color} onChange={e => setOpts({ ...opts, color: e.target.checked })} />Match the reference's look</label>
          <label className="check"><input type="checkbox" checked={opts.fill} onChange={e => setOpts({ ...opts, fill: e.target.checked })} />Fill the frame (crop footage of a different shape)</label>
          <label className="check"><input type="checkbox" checked={opts.adoptFormat} disabled={sameFormat} onChange={e => setOpts({ ...opts, adoptFormat: e.target.checked })} />Use the reference's frame size and rate{fmt ? ` (${fmt})` : ''}</label>
          <div className="field-row"><label>Sound</label>
            <Seg value={opts.audio} onChange={v => setOpts({ ...opts, audio: v })} options={[
              { value: 'reference', label: 'Reference', title: 'Use the reference’s soundtrack, so the cuts stay on the beat' },
              { value: 'footage', label: 'Footage', title: 'Keep each clip’s own sound' },
              { value: 'both', label: 'Both' },
              { value: 'none', label: 'None' },
            ]} />
          </div>
          {analysis && !analysis.hasAudio && (opts.audio === 'reference' || opts.audio === 'both') && <div className="dim small">The reference has no sound.</div>}
        </div>
      </div>
    </Modal>
  );
}

/** The reference's shots as a proportional strip: transitions and moves marked. */
function ShotStrip({ a }: { a: RefAnalysis }) {
  const shots = useMemo(() => a.shots.map((s, i) => ({ ...s, i })), [a]);
  return (
    <div className="shot-strip" data-testid="match-strip">
      {shots.map(s => (
        <div key={s.i} className={`shot${s.transitionIn ? ` tr-${s.transitionIn.type}` : ''}`} style={{ flexGrow: Math.max(0.05, s.end - s.start) }}
          title={`Shot ${s.i + 1}: ${s.start.toFixed(2)}–${s.end.toFixed(2)} s${s.transitionIn ? ` · ${s.transitionIn.type === 'dip' ? 'dip to black' : 'dissolve'} ${s.transitionIn.duration.toFixed(2)} s` : ''}${s.motion ? ` · ${s.motion.size < 0.98 ? 'zoom in' : s.motion.size > 1.02 ? 'zoom out' : 'pan'}` : ''}`}>
          {s.transitionIn && <ArrowRightLeft size={10} />}
          {s.motion && <ZoomIn size={10} />}
          {!s.transitionIn && !s.motion && <Check size={10} className="dim" />}
        </div>
      ))}
    </div>
  );
}

if (typeof window !== 'undefined') (window as any).__pspMatch = { runMatchEdit, analyzeMedia, useMatchEdit };
