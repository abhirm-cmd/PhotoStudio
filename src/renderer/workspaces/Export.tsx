import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Save, Trash2, Download, CheckCircle2, AlertTriangle, X, FileImage } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { SidePanel } from '../components/Panel';
import { Section, Seg, Slider, Progress, Empty, promptText, confirmDialog } from '../components/ui';
import { Thumb } from '../components/Thumb';
import { api } from '../api';
import { startExport, defaultExportSettings, type ExportJob } from '../services/exporter';
import { targetSize } from '@shared/exportSize';
import type { ExportPreset, ExportProgress, ExportSettings } from '@shared/types';
import { uid } from '@shared/edit';
import { formatBytes } from '../library/format';

const TOKENS = ['{filename}', '{seq}', '{date}', '{YYYY}', '{MM}', '{DD}', '{camera}', '{rating}', '{title}'];

export function ExportWorkspace() {
  const photos = useLibrary(s => s.photos);
  const selection = useLibrary(s => s.selection);
  const [scope, setScope] = useState<'selected' | 'all'>(selection.length ? 'selected' : 'all');
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [prog, setProg] = useState<ExportProgress | null>(null);

  useEffect(() => {
    (async () => {
      const [dir, list] = await Promise.all([api.exportDefaultDir(), api.exportPresetList()]);
      setPresets(list);
      let saved: ExportSettings | null = null;
      try { saved = JSON.parse(localStorage.getItem('photostudio.export') ?? 'null'); } catch { /* ignore */ }
      setSettings(saved ? { ...defaultExportSettings(dir), ...saved } : defaultExportSettings(dir));
    })();
  }, []);
  useEffect(() => { if (settings) try { localStorage.setItem('photostudio.export', JSON.stringify(settings)); } catch { /* ignore */ } }, [settings]);

  const items = useMemo(() => (scope === 'selected' ? photos.filter(p => selection.includes(p.id)) : photos).filter(p => p.thumbState !== 'error'), [scope, photos, selection]);
  if (!settings) return <div className="center"><div className="viewer-loading"><div className="spinner" /></div></div>;
  const set = (patch: Partial<ExportSettings>) => { setSettings({ ...settings, ...patch }); setPresetId(null); };
  const running = !!job && prog?.phase !== 'done' && prog?.phase !== 'cancelled';

  const run = () => {
    if (!items.length) return;
    setProg(null);
    const j = startExport(items, settings, p => {
      setProg(p);
      const app = useApp.getState();
      if (p.phase === 'done' || p.phase === 'cancelled') app.endTask(p.jobId);
      else app.setTask({ id: p.jobId, label: 'Exporting', done: p.done, total: p.total, detail: p.current, cancel: () => j.cancel() });
    });
    setJob(j);
    j.done.then(p => {
      const app = useApp.getState();
      if (p.phase === 'cancelled') app.toast({ kind: 'info', title: 'Export cancelled', body: `${p.done - p.failed} file${p.done - p.failed === 1 ? '' : 's'} written before cancelling.` });
      else app.toast({ kind: p.failed ? 'error' : 'success', title: p.failed ? `Exported with ${p.failed} error${p.failed > 1 ? 's' : ''}` : `Exported ${p.outputs?.length ?? 0} photo${(p.outputs?.length ?? 0) === 1 ? '' : 's'}`, body: p.failed ? p.message : settings.destination, action: p.outputs?.length ? { label: 'Show files', run: () => api.revealPath(p.outputs![0]) } : undefined });
    });
  };

  const first = items[0];
  const est = first ? targetSize(settings.resize, first.width, first.height) ?? { width: first.width, height: first.height } : null;

  return (
    <>
      <SidePanel side="left">
        <Section id="export.presets" title="Export Presets">
          {presets.map(p => (
            <div key={p.id} className={`nav-item${presetId === p.id ? ' active' : ''}`} onClick={() => { setSettings({ ...p.settings, destination: p.settings.destination || settings.destination }); setPresetId(p.id); }} role="button">
              <FileImage size={14} /><span className="name">{p.name}</span>
              {!p.builtin && <button className="icon-btn sm" onClick={async e => { e.stopPropagation(); if (await confirmDialog(`Delete “${p.name}”?`, 'This removes the export preset.', { okLabel: 'Delete', danger: true })) { await api.deleteExportPreset(p.id); setPresets(await api.exportPresetList()); } }} aria-label="Delete preset"><Trash2 size={11} /></button>}
            </div>
          ))}
          <button className="btn sm ghost mt8" onClick={async () => {
            const name = await promptText('Save export preset', '', { label: 'Name', okLabel: 'Save' });
            if (!name) return;
            const p: ExportPreset = { id: uid('xp'), name, builtin: false, settings };
            await api.saveExportPreset(p);
            setPresets(await api.exportPresetList());
            setPresetId(p.id);
          }}><Save size={12} />Save current as preset</button>
        </Section>
      </SidePanel>
      <div className="center">
        <div className="lib-toolbar">
          <Seg value={scope} onChange={setScope} options={[{ value: 'selected', label: `Selected (${selection.length})` }, { value: 'all', label: `All in view (${photos.length})` }]} />
          <div className="grow" />
          {est && <span className="muted small">{items.length} photo{items.length === 1 ? '' : 's'} · ~{est.width} × {est.height}px · {settings.format.toUpperCase()}{settings.format !== 'jpeg' && settings.format !== 'dng' ? ` ${settings.bitDepth}-bit` : ''} · {settings.colorSpace}</span>}
          {running
            ? <button className="btn" onClick={() => job?.cancel()}><X size={14} />Cancel</button>
            : <button className="btn primary" disabled={!items.length} onClick={run}><Download size={14} />Export {items.length || ''}</button>}
        </div>
        {prog && (
          <div className="export-progress">
            <div className="row between"><span className="text-0">{prog.phase === 'done' ? 'Export complete' : prog.phase === 'cancelled' ? 'Cancelled' : `${prog.phase === 'encoding' ? 'Writing' : 'Rendering'} ${prog.current ?? ''}`}</span><span className="muted">{prog.done}/{prog.total}{prog.failed ? ` · ${prog.failed} failed` : ''}</span></div>
            <Progress value={prog.done} total={prog.total} />
            {prog.phase === 'done' && prog.outputs?.length ? <button className="btn sm mt8" onClick={() => api.revealPath(prog.outputs![0])}><FolderOpen size={12} />Show in folder</button> : null}
            {prog.failed > 0 && <div className="notice warn mt8"><AlertTriangle size={14} />{prog.message}</div>}
          </div>
        )}
        {items.length ? (
          <div className="export-list">
            {items.map((p, i) => {
              const done = prog && prog.done > i, failed = false;
              return (
                <div key={p.id} className="export-item">
                  <div className="export-thumb"><Thumb photo={p} /></div>
                  <div className="grow">
                    <div className="text-0">{p.filename}{p.copyName ? ` · ${p.copyName}` : ''}</div>
                    <div className="dim small">{p.width} × {p.height} · {formatBytes(p.fileSize)}{p.hasEdits ? ' · edited' : ''}</div>
                  </div>
                  {done && !failed && <CheckCircle2 size={16} className="ok" />}
                </div>
              );
            })}
          </div>
        ) : <Empty kind="export" title={scope === 'selected' ? 'No photos selected' : 'No photos to export'}><p>Select photos in the Library or filmstrip, then come back here.</p></Empty>}
      </div>
      <SidePanel side="right"><ExportSettingsForm s={settings} set={set} /></SidePanel>
    </>
  );
}

function ExportSettingsForm({ s, set }: { s: ExportSettings; set(p: Partial<ExportSettings>): void }) {
  const r = s.resize;
  const preview = s.filenameTemplate.replace('{filename}', 'IMG_0421').replace('{seq}', '001').replace('{date}', '2026-05-14').replace('{YYYY}', '2026').replace('{MM}', '05').replace('{DD}', '14').replace('{camera}', 'Z6').replace('{rating}', '5').replace('{title}', 'Lake');
  return (
    <>
      <Section id="exp.loc" title="Location">
        <div className="field">
          <label>Folder</label>
          <div className="row"><input className="input sm grow" value={s.destination} onChange={e => set({ destination: e.target.value })} onKeyDown={e => e.stopPropagation()} /><button className="icon-btn" onClick={async () => { const d = await api.pickFolder('Export to'); if (d) set({ destination: d }); }} aria-label="Choose folder"><FolderOpen size={14} /></button></div>
        </div>
        <div className="field"><label>Subfolder (optional)</label><input className="input sm" value={s.subfolder} onChange={e => set({ subfolder: e.target.value })} onKeyDown={e => e.stopPropagation()} /></div>
        <div className="field-row"><label>Existing files</label>
          <select className="input sm grow" value={s.conflict} onChange={e => set({ conflict: e.target.value as any })}><option value="unique">Choose a new name</option><option value="overwrite">Overwrite</option><option value="skip">Skip</option></select>
        </div>
      </Section>
      <Section id="exp.name" title="File Naming">
        <input className="input sm" value={s.filenameTemplate} onChange={e => set({ filenameTemplate: e.target.value })} onKeyDown={e => e.stopPropagation()} aria-label="Filename template" />
        <div className="chips mt8">{TOKENS.map(t => <button key={t} className="chip" onClick={() => set({ filenameTemplate: s.filenameTemplate + (s.filenameTemplate ? '_' : '') + t })}>{t}</button>)}</div>
        <p className="dim small">Example: {preview}.{s.format === 'jpeg' ? 'jpg' : s.format === 'tiff' ? 'tif' : s.format}</p>
      </Section>
      <Section id="exp.file" title="File Settings">
        <Seg full value={s.format} onChange={v => set({ format: v })} options={[{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'tiff', label: 'TIFF' }, { value: 'dng', label: 'DNG' }]} />
        {s.format === 'jpeg' && <Slider label="Quality" min={1} max={100} defaultValue={90} value={s.quality} onChange={v => set({ quality: v })} />}
        {(s.format === 'png' || s.format === 'tiff') && (
          <div className="field-row mt8"><label>Bit depth</label><Seg value={String(s.bitDepth) as '8' | '16'} onChange={v => set({ bitDepth: Number(v) as 8 | 16 })} options={[{ value: '8', label: '8-bit' }, { value: '16', label: '16-bit' }]} /></div>
        )}
        {s.format === 'dng' ? <p className="dim small mt8">Linear DNG with your edits rendered into 16-bit scene-linear Rec.2020 data, readable by DNG-aware editors.</p> : (
          <div className="field-row mt8"><label>Color space</label>
            <select className="input sm grow" value={s.colorSpace} onChange={e => set({ colorSpace: e.target.value as any })}>
              <option value="srgb">sRGB (web, most screens)</option><option value="display-p3">Display P3</option><option value="adobe-rgb">Adobe RGB (1998)</option><option value="prophoto">ProPhoto RGB</option>
            </select>
          </div>
        )}
      </Section>
      {s.format !== 'dng' && (
        <Section id="exp.size" title="Image Sizing">
          <select className="input sm" value={r.mode} onChange={e => set({ resize: { ...r, mode: e.target.value as any } })} aria-label="Resize mode">
            <option value="none">Full resolution</option><option value="long">Long edge</option><option value="short">Short edge</option><option value="width">Width</option><option value="height">Height</option><option value="dimensions">Fit within W × H</option><option value="megapixels">Megapixels</option>
          </select>
          {(r.mode === 'long' || r.mode === 'short') && <NumField label="Pixels" value={r.long} onChange={v => set({ resize: { ...r, long: v } })} />}
          {(r.mode === 'width' || r.mode === 'dimensions') && <NumField label="Width" value={r.width} onChange={v => set({ resize: { ...r, width: v } })} />}
          {(r.mode === 'height' || r.mode === 'dimensions') && <NumField label="Height" value={r.height} onChange={v => set({ resize: { ...r, height: v } })} />}
          {r.mode === 'megapixels' && <NumField label="Megapixels" value={r.megapixels} onChange={v => set({ resize: { ...r, megapixels: v } })} step={0.5} />}
          {r.mode !== 'none' && <label className="check mt8"><input type="checkbox" checked={r.noEnlarge} onChange={e => set({ resize: { ...r, noEnlarge: e.target.checked } })} />Don't enlarge</label>}
          <NumField label="Resolution (ppi)" value={s.ppi} onChange={v => set({ ppi: v })} />
        </Section>
      )}
      {s.format !== 'dng' && (
        <Section id="exp.sharp" title="Output Sharpening" defaultOpen={false}>
          <label className="check"><input type="checkbox" checked={s.sharpen.enabled} onChange={e => set({ sharpen: { ...s.sharpen, enabled: e.target.checked } })} />Sharpen for</label>
          {s.sharpen.enabled && (
            <div className="row mt8">
              <select className="input sm grow" value={s.sharpen.target} onChange={e => set({ sharpen: { ...s.sharpen, target: e.target.value as any } })}><option value="screen">Screen</option><option value="matte">Matte paper</option><option value="glossy">Glossy paper</option></select>
              <select className="input sm grow" value={s.sharpen.amount} onChange={e => set({ sharpen: { ...s.sharpen, amount: e.target.value as any } })}><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option></select>
            </div>
          )}
        </Section>
      )}
      <Section id="exp.meta" title="Metadata" defaultOpen={false}>
        <select className="input sm" value={s.metadata} onChange={e => set({ metadata: e.target.value as any })} aria-label="Metadata"><option value="all">All metadata</option><option value="copyright">Copyright only</option><option value="none">None</option></select>
        <label className="check mt8"><input type="checkbox" checked={s.removeLocation} onChange={e => set({ removeLocation: e.target.checked })} />Remove location info</label>
      </Section>
      {s.format !== 'dng' && (
        <Section id="exp.wm" title="Watermark" defaultOpen={false}>
          <label className="check"><input type="checkbox" checked={!!s.watermark?.enabled} onChange={e => set({ watermark: { ...(s.watermark ?? { text: '© ', opacity: 60, size: 3, position: 'br' }), enabled: e.target.checked } })} />Add text watermark</label>
          {s.watermark?.enabled && (
            <>
              <input className="input sm mt8" value={s.watermark.text} onChange={e => set({ watermark: { ...s.watermark!, text: e.target.value } })} onKeyDown={e => e.stopPropagation()} aria-label="Watermark text" />
              <Slider label="Opacity" min={5} max={100} defaultValue={60} value={s.watermark.opacity} onChange={v => set({ watermark: { ...s.watermark!, opacity: v } })} />
              <Slider label="Size" min={1} max={15} step={0.5} defaultValue={3} value={s.watermark.size} onChange={v => set({ watermark: { ...s.watermark!, size: v } })} format={v => `${v}%`} />
              <select className="input sm" value={s.watermark.position} onChange={e => set({ watermark: { ...s.watermark!, position: e.target.value as any } })} aria-label="Position">
                <option value="br">Bottom right</option><option value="bl">Bottom left</option><option value="tr">Top right</option><option value="tl">Top left</option><option value="center">Center</option>
              </select>
            </>
          )}
        </Section>
      )}
    </>
  );
}

function NumField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange(v: number): void; step?: number }) {
  return (
    <div className="field-row mt8"><label>{label}</label>
      <input className="input sm grow" type="number" step={step} min={0} value={value} onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v > 0) onChange(v); }} onKeyDown={e => e.stopPropagation()} />
    </div>
  );
}
