/** Deliver page: render the timeline to a file with FFmpeg, on this computer. */
import React, { useEffect, useState } from 'react';
import { Film, FolderOpen, X, Terminal, ShieldCheck, Play } from 'lucide-react';
import { type Project, projectDuration, timecode } from '@shared/project';
import { FORMAT_INFO, type ExportFormat, type ExportOptions } from '@shared/ffgraph';
import { isNeutral, writeCube } from '@shared/grade';
import { useProject, P } from '../store/project';
import { toast } from '../store/ui';
import { api, type ExportProgress } from '../api';
import { gradeLut, importedLut } from '../player/engine';
import { titlePng } from '../player/titles';
import { ProgramMonitor } from '../components/Monitors';
import { Seg, Slider, Progress, Section, Empty, confirmDialog } from '../components/ui';

interface Job { id: string; name: string; output: string; format: ExportFormat; progress: number; eta: number | null; speed: number; state: 'running' | 'done' | 'failed' | 'cancelled'; error?: string; log?: string; started: number; finished?: number }

const SIZES = [
  { id: 'project', label: 'Sequence size' }, { id: '3840x2160', label: '4K UHD 3840×2160' }, { id: '1920x1080', label: '1080p 1920×1080' },
  { id: '1280x720', label: '720p 1280×720' }, { id: 'half', label: 'Half size' },
];

/** Grade LUTs and title images the export needs, prepared in the renderer. */
export async function exportAssets(p: Project) {
  const luts: Record<string, string> = {};
  const titles: Record<string, Uint8Array> = {};
  // Load imported .cube files first so baked grades include them
  await Promise.all(p.clips.filter(c => c.grade.lut && !c.grade.bypass).map(c => new Promise<void>(res => { if (importedLut(c.grade.lut!.path, res) !== undefined) res(); })));
  for (const c of p.clips) {
    if (c.kind === 'media' && !isNeutral(c.grade)) { const l = gradeLut(c.grade); if (l) luts[c.id] = writeCube(l.lut); }
    if (c.kind === 'title' && c.title) titles[c.id] = await titlePng(c.title, p.settings.width, p.settings.height);
  }
  return { luts, titles };
}

export function DeliverPage() {
  const p = useProject(s => s.project);
  const file = useProject(s => s.file);
  const [format, setFormat] = useState<ExportFormat>('h264');
  const [size, setSize] = useState('project');
  const [crf, setCrf] = useState(18);
  const [abr, setAbr] = useState(320);
  const [range, setRange] = useState<'all' | 'inout'>('all');
  const [dir, setDir] = useState<string>('');
  const [name, setName] = useState(p.name || 'Untitled');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cmd, setCmd] = useState<string | null>(null);
  const info = FORMAT_INFO[format];
  const dur = projectDuration(p);
  const hasIO = p.inPoint != null || p.outPoint != null;

  useEffect(() => { void api.defaultExportDir().then(d => setDir(x => x || d)); }, []);
  useEffect(() => { setName(n => (n === 'Untitled' ? p.name : n)); }, [p.name]);
  useEffect(() => api.on('export:progress', (e: ExportProgress) => setJobs(js => js.map(j => (j.id === e.jobId ? { ...j, progress: e.progress, eta: e.eta, speed: e.speed } : j)))), []);

  const output = `${dir}${dir.includes('\\') ? '\\' : '/'}${name}.${info.ext}`;
  const opts = (): ExportOptions => {
    let width: number | undefined, height: number | undefined;
    if (size === 'half') { width = p.settings.width / 2; height = p.settings.height / 2; }
    else if (size !== 'project') {
      // Fit the chosen box keeping the sequence aspect (vertical sequences stay vertical)
      const [bw, bh] = size.split('x').map(Number);
      const s = p.settings.height > p.settings.width ? Math.min(bh / p.settings.width, bw / p.settings.height) : Math.min(bw / p.settings.width, bh / p.settings.height);
      width = p.settings.width * s; height = p.settings.height * s;
    }
    return {
      format, width, height, crf, audioBitrate: abr, output,
      from: range === 'inout' ? p.inPoint ?? 0 : 0,
      to: range === 'inout' ? p.outPoint ?? dur : dur,
    };
  };
  const missing = p.media.filter(m => m.missing && p.clips.some(c => c.mediaId === m.id));
  const running = jobs.some(j => j.state === 'running');

  const pickDir = async () => { const f = await api.pickOutput(name, info.ext); if (f) { const i = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')); setDir(f.slice(0, i)); setName(f.slice(i + 1).replace(new RegExp(`\\.${info.ext}$`, 'i'), '')); } };

  const render = async () => {
    const proj = P();
    if (!proj.clips.length) { toast({ kind: 'info', title: 'The timeline is empty' }); return; }
    if (missing.length) { toast({ kind: 'error', title: 'Media is offline', body: missing.map(m => m.name).join(', ') }); return; }
    const o = opts();
    const [exists] = await api.exists([o.output]);
    if (exists && !(await confirmDialog('Replace the existing file?', `${o.output} already exists. Rendering will replace it.`, { okLabel: 'Replace', danger: true }))) return;
    const id = `job_${Date.now().toString(36)}`;
    const job: Job = { id, name: `${name}.${info.ext}`, output: o.output, format, progress: 0, eta: null, speed: 0, state: 'running', started: Date.now() };
    setJobs(js => [job, ...js]);
    try {
      const assets = await exportAssets(proj);
      const r = await api.startExport(id, proj, o, assets);
      setJobs(js => js.map(j => (j.id === id ? { ...j, state: r.ok ? 'done' : r.error === 'Cancelled' ? 'cancelled' : 'failed', progress: r.ok ? 1 : j.progress, error: r.error, log: r.log, finished: Date.now() } : j)));
      if (r.ok) toast({ kind: 'success', title: 'Export finished', body: r.output, action: { label: 'Show in folder', run: () => api.showInFolder(r.output!) } }, 8000);
      else if (r.error !== 'Cancelled') toast({ kind: 'error', title: 'Export failed', body: r.error }, 10000);
    } catch (e: any) {
      setJobs(js => js.map(j => (j.id === id ? { ...j, state: 'failed', error: String(e?.message ?? e), finished: Date.now() } : j)));
      toast({ kind: 'error', title: 'Export failed', body: String(e?.message ?? e) }, 10000);
    }
  };

  const showCmd = async () => {
    if (cmd) { setCmd(null); return; }
    const r = await api.exportCommand(P(), opts());
    setCmd(['ffmpeg', ...r.args].map(a => (/[\s;'"[\]]/.test(a) ? JSON.stringify(a) : a)).join(' '));
  };

  const graded = p.clips.filter(c => c.kind === 'media' && !isNeutral(c.grade)).length;
  const titles = p.clips.filter(c => c.kind === 'title').length;
  const from = range === 'inout' ? p.inPoint ?? 0 : 0, to = range === 'inout' ? p.outPoint ?? dur : dur;

  return (
    <div className="page deliver-page">
      <div className="deliver-settings panel-scroll">
        <div className="panel-title">Render settings</div>
        <Section id="d-file" title="File">
          <div className="field"><label>Name</label><input className="input" value={name} onChange={e => setName(e.target.value.replace(/[\\/:*?"<>|]/g, '_'))} data-testid="export-name" /></div>
          <div className="field"><label>Location</label><div className="row"><input className="input" value={dir} onChange={e => setDir(e.target.value)} data-testid="export-dir" /><button className="btn" onClick={pickDir}><FolderOpen size={13} /></button></div></div>
        </Section>
        <Section id="d-fmt" title="Format">
          <div className="field"><label>Preset</label>
            <select className="input" value={format} onChange={e => setFormat(e.target.value as ExportFormat)} data-testid="export-format">
              {(Object.keys(FORMAT_INFO) as ExportFormat[]).map(f => <option key={f} value={f}>{FORMAT_INFO[f].label}</option>)}
            </select>
          </div>
          {info.video && <div className="field"><label>Resolution</label><select className="input" value={size} onChange={e => setSize(e.target.value)}>{SIZES.map(s => <option key={s.id} value={s.id}>{s.id === 'project' ? `${s.label} (${p.settings.width}×${p.settings.height})` : s.label}</option>)}</select></div>}
          {(format === 'h264' || format === 'h265') && <Slider label="Quality (CRF)" value={crf} min={12} max={34} defaultValue={18} onChange={setCrf} format={v => `${Math.round(v)} · ${v <= 16 ? 'Very high' : v <= 20 ? 'High' : v <= 26 ? 'Medium' : 'Small file'}`} />}
          {format !== 'wav' && format !== 'prores' && <div className="field"><label>Audio bitrate</label><Seg value={String(abr)} options={['128', '192', '256', '320'].map(v => ({ value: v, label: `${v}k` }))} onChange={v => setAbr(Number(v))} /></div>}
        </Section>
        <Section id="d-range" title="Range">
          <Seg full value={range} options={[{ value: 'all', label: 'Entire timeline' }, { value: 'inout', label: 'In to out' }]} onChange={v => setRange(v)} />
          {range === 'inout' && !hasIO && <p className="dim small">No in/out marks are set; the whole timeline renders. Mark them with I and O.</p>}
          <dl className="kv mt8"><dt>From</dt><dd>{timecode(from, p.settings.fps)}</dd><dt>To</dt><dd>{timecode(to, p.settings.fps)}</dd><dt>Duration</dt><dd>{timecode(Math.max(0, to - from), p.settings.fps)}</dd></dl>
        </Section>
        <div className="notice mt12" style={{ margin: '12px 14px' }}><ShieldCheck size={15} /><div>Rendering runs on this computer with FFmpeg. Nothing is uploaded, and your source files are only read, never changed.</div></div>
        {missing.length > 0 && <div className="notice warn" style={{ margin: '0 14px 12px' }}><div>{missing.length} offline file{missing.length > 1 ? 's' : ''} must be relinked before rendering.</div></div>}
        <div style={{ padding: '0 14px 16px' }} className="col">
          <button className="btn primary lg block" onClick={render} disabled={!p.clips.length || missing.length > 0 || !dir || !name} data-testid="render"><Film size={15} />{running ? 'Add to render queue' : 'Render'}</button>
          <button className="btn sm ghost" onClick={showCmd}><Terminal size={12} />{cmd ? 'Hide' : 'Show'} FFmpeg command</button>
          {cmd && <textarea className="input mono" readOnly rows={8} value={cmd} />}
        </div>
      </div>
      <div className="deliver-main">
        <ProgramMonitor compact showTransform={false} />
        <div className="queue">
          <div className="panel-title">Render queue {file ? '' : <span className="dim small">· project not saved yet</span>}</div>
          {!jobs.length && <Empty kind="export" title="Nothing rendered yet" small><p>{p.clips.length} clips · {graded} graded · {titles} titles · {timecode(dur, p.settings.fps)}</p></Empty>}
          {jobs.map(j => (
            <div key={j.id} className={`job ${j.state}`} data-testid="job">
              <div className="row"><b className="nm">{j.name}</b><span className="tag">{FORMAT_INFO[j.format].label}</span><span className="grow" />
                {j.state === 'running' && <button className="btn sm" onClick={() => api.cancelExport(j.id)}><X size={12} />Cancel</button>}
                {j.state === 'done' && <><button className="btn sm" onClick={() => api.openPath(j.output)}><Play size={12} />Open</button><button className="btn sm" onClick={() => api.showInFolder(j.output)}><FolderOpen size={12} />Show</button></>}
                {j.state === 'failed' && j.log && <button className="btn sm" onClick={() => api.showInFolder(j.log!)}>Show log</button>}
              </div>
              {j.state === 'running' && <><Progress value={j.progress} total={1} /><div className="dim small">{Math.round(j.progress * 100)}% · {j.speed ? `${j.speed.toFixed(2)}× realtime` : 'starting'}{j.eta != null ? ` · about ${Math.ceil(j.eta)} s left` : ''}</div></>}
              {j.state === 'done' && <div className="dim small">Finished in {((j.finished! - j.started) / 1000).toFixed(1)} s · {j.output}</div>}
              {j.state === 'failed' && <div className="small" style={{ color: 'var(--danger)' }}>{j.error}</div>}
              {j.state === 'cancelled' && <div className="dim small">Cancelled. The incomplete file was removed.</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

