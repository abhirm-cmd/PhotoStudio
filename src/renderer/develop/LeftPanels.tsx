import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Camera, Star, ChevronRight, Search, Upload, Download, Sparkles, FolderOpen } from 'lucide-react';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { activePhoto, useLibrary } from '../store/library';
import { Section, Slider, openMenu, promptText, confirmDialog } from '../components/ui';
import { api, media } from '../api';
import { presetEdit } from '../services/batch';
import { normalizeEdit, cloneEdit, type EditParams } from '@shared/edit';
import type { Preset, Snapshot } from '@shared/types';
import { groupBy } from '../library/InfoPanel';
import { formatDate } from '../library/format';

/* ------------------------------------------------------------- navigator */

export function Navigator() {
  const id = useDevelop(s => s.photoId);
  const v = useLibrary(s => (id != null ? s.thumbVersions[id] ?? 0 : 0));
  const zoom = useDevelop(s => s.zoom);
  const center = useDevelop(s => s.center);
  if (id == null) return null;
  const set = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    useDevelop.getState().set({ center: [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height], zoom: typeof zoom === 'number' ? zoom : 1 });
  };
  return (
    <Section id="dev.nav" title="Navigator">
      <div className="navigator" onClick={set}>
        <img src={media.thumb(id, v)} alt="" draggable={false} />
        {typeof zoom === 'number' && <div className="nav-box" style={{ left: `${center[0] * 100}%`, top: `${center[1] * 100}%` }} />}
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- presets */

let presetCache: Preset[] | null = null;
const presetListeners = new Set<(p: Preset[]) => void>();
export async function reloadPresets() {
  presetCache = await api.presets();
  presetListeners.forEach(f => f(presetCache!));
  return presetCache;
}
export function usePresets(): Preset[] {
  const [list, setList] = useState<Preset[]>(presetCache ?? []);
  useEffect(() => { presetListeners.add(setList); if (!presetCache) reloadPresets(); return () => { presetListeners.delete(setList); }; }, []);
  return list;
}

export function PresetsSection() {
  const presets = usePresets();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('photostudio.presetFolders') ?? '{}'); } catch { return {}; } });
  const [applied, setApplied] = useState<{ preset: Preset; base: EditParams; amount: number } | null>(null);
  const photoId = useDevelop(s => s.photoId);
  useEffect(() => setApplied(null), [photoId]);
  const toggle = (f: string) => setOpen(o => { const n = { ...o, [f]: !(o[f] ?? false) }; try { localStorage.setItem('photostudio.presetFolders', JSON.stringify(n)); } catch { /* ignore */ } return n; });

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? presets.filter(p => p.name.toLowerCase().includes(s) || p.folder.toLowerCase().includes(s)) : presets;
  }, [presets, q]);
  const favorites = filtered.filter(p => p.favorite);
  const groups = groupBy(filtered, p => p.folder);

  const hover = (p: Preset | null) => {
    const dev = useDevelop.getState();
    if (!p || dev.photoId == null) return dev.setPreview(null);
    dev.setPreview(presetEdit(dev.edit, p), `Preview: ${p.name}`);
  };
  const apply = (p: Preset) => {
    const dev = useDevelop.getState();
    if (dev.photoId == null) return;
    const base = cloneEdit(dev.edit);
    dev.setPreview(null);
    dev.replaceEdit(presetEdit(base, p), `Preset: ${p.name}`, { presetName: p.name });
    setApplied({ preset: p, base, amount: 100 });
  };

  const row = (p: Preset) => (
    <div key={p.id} className={`preset-row${applied?.preset.id === p.id ? ' active' : ''}`} onMouseEnter={() => hover(p)} onMouseLeave={() => hover(null)} onClick={() => apply(p)}
      onContextMenu={e => openMenu(e, presetMenu(p))} title={p.source?.note ?? p.name} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') apply(p); }}>
      {p.source?.kind === 'ai' || p.source?.kind === 'reference-grade' ? <Sparkles size={11} className="accent" /> : <span className="preset-dot" />}
      <span className="name">{p.name}</span>
      {p.favorite && <Star size={10} className="accent" fill="currentColor" />}
    </div>
  );

  return (
    <Section id="dev.presets" title="Presets" actions={<>
      <button className="icon-btn sm" title="Create preset from current settings" onClick={() => useApp.getState().openModal('savePreset')}><Plus size={13} /></button>
      <button className="icon-btn sm" title="More" onClick={e => openMenu(e, [
        { label: 'Import Presets…', icon: <Upload size={14} />, onClick: async () => { const n = await api.importPresets(); await reloadPresets(); useApp.getState().toast({ kind: 'success', title: `Imported ${n.length} preset${n.length === 1 ? '' : 's'}` }); } },
        { label: 'Export My Presets…', icon: <Download size={14} />, onClick: async () => { const f = await api.exportPresets(presets.filter(p => !p.builtin)); if (f) useApp.getState().toast({ kind: 'success', title: 'Presets exported', body: f }); } },
        { label: 'Open Presets Workspace', icon: <FolderOpen size={14} />, onClick: () => useApp.getState().setWorkspace('presets') },
      ])}><ChevronRight size={13} /></button>
    </>}>
      <div className="search sm mb8"><Search size={12} /><input className="input sm" placeholder="Search presets" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} /></div>
      {applied && (
        <div className="preset-amount">
          <Slider label={`Amount · ${applied.preset.name}`} min={0} max={200} defaultValue={100} value={applied.amount}
            onChange={v => { setApplied({ ...applied, amount: v }); useDevelop.getState().setEdit(() => presetEdit(applied.base, applied.preset, v / 100)); }}
            onCommit={v => useDevelop.getState().commit(`Preset: ${applied.preset.name} ${Math.round(v)}%`)} format={v => `${Math.round(v)}%`} />
        </div>
      )}
      {favorites.length > 0 && <PresetFolder name="Favorites" open={open['★'] ?? true} onToggle={() => toggle('★')}>{favorites.map(row)}</PresetFolder>}
      {groups.map(([folder, list]) => <PresetFolder key={folder} name={folder} count={list.length} open={q ? true : open[folder] ?? false} onToggle={() => toggle(folder)}>{list.map(row)}</PresetFolder>)}
      {!filtered.length && <p className="dim small">No presets match.</p>}
    </Section>
  );
}

function PresetFolder({ name, count, open, onToggle, children }: { name: string; count?: number; open: boolean; onToggle(): void; children: React.ReactNode }) {
  return (
    <div className="preset-folder">
      <div className="preset-folder-head" onClick={onToggle} role="button" aria-expanded={open}><ChevronRight size={11} className={open ? 'rot90' : ''} />{name}{count != null && <span className="count">{count}</span>}</div>
      {open && <div className="preset-folder-body">{children}</div>}
    </div>
  );
}

export function presetMenu(p: Preset) {
  return [
    { label: p.favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: <Star size={14} />, onClick: async () => { await api.savePreset({ ...p, favorite: !p.favorite }); reloadPresets(); } },
    { label: 'Apply to Selected Photos', onClick: async () => { const { applyPresetToPhotos } = await import('../services/batch'); applyPresetToPhotos(useLibrary.getState().targetIds(), p); } },
    ...(!p.builtin ? [
      { label: 'Update with Current Settings', onClick: async () => {
        const { pickGroups } = await import('@shared/edit');
        await api.savePreset({ ...p, settings: pickGroups(useDevelop.getState().edit, p.groups) });
        reloadPresets();
        useApp.getState().toast({ kind: 'success', title: `Updated ${p.name}` });
      } },
      { label: 'Rename…', onClick: async () => { const n = await promptText('Rename preset', p.name); if (n) { await api.savePreset({ ...p, name: n }); reloadPresets(); } } },
      { sep: true },
      { label: 'Delete Preset', icon: <Trash2 size={14} />, danger: true, onClick: async () => { if (await confirmDialog(`Delete “${p.name}”?`, 'Photos that used it keep their settings.', { okLabel: 'Delete', danger: true })) { await api.deletePreset(p.id); reloadPresets(); } } },
    ] : []),
  ];
}

/* ------------------------------------------------------------- snapshots */

export function SnapshotsSection() {
  const id = useDevelop(s => s.photoId);
  const [list, setList] = useState<Snapshot[]>([]);
  const load = () => { if (id != null) api.snapshots(id).then(setList); };
  useEffect(load, [id]);
  if (id == null) return null;
  const add = async () => {
    const name = await promptText('New snapshot', formatDate(new Date().toISOString()), { label: 'Name', okLabel: 'Create' });
    if (!name) return;
    await useDevelop.getState().commit();
    await api.addSnapshot(id, name, useDevelop.getState().edit);
    load();
  };
  return (
    <Section id="dev.snapshots" title="Snapshots" defaultOpen={false} actions={<button className="icon-btn sm" title="Create snapshot" onClick={add}><Camera size={13} /></button>}>
      {list.map(s => (
        <div key={s.id} className="hist-row" onClick={() => useDevelop.getState().replaceEdit(normalizeEdit(s.edit, useDevelop.getState().isRaw), `Snapshot: ${s.name}`)}
          onMouseEnter={() => useDevelop.getState().setPreview(normalizeEdit(s.edit, useDevelop.getState().isRaw), s.name)} onMouseLeave={() => useDevelop.getState().setPreview(null)}>
          <span className="name">{s.name}</span>
          <button className="icon-btn sm" onClick={async e => { e.stopPropagation(); await api.deleteSnapshot(s.id); load(); }} aria-label="Delete snapshot"><Trash2 size={11} /></button>
        </div>
      ))}
      {!list.length && <p className="dim small">Snapshots save the current look so you can return to it or compare versions.</p>}
    </Section>
  );
}

/* --------------------------------------------------------------- history */

export function HistorySection() {
  const history = useDevelop(s => s.history);
  const index = useDevelop(s => s.index);
  const jumpTo = useDevelop(s => s.jumpTo);
  return (
    <Section id="dev.history" title="History" actions={<button className="icon-btn sm" title="Clear history above current step" onClick={async () => {
      const dev = useDevelop.getState();
      if (dev.photoId == null || dev.index >= dev.history.length - 1) return;
      const h = dev.history[dev.index];
      if (h.id != null) await api.truncateHistory(dev.photoId, h.id);
      useDevelop.setState({ history: dev.history.slice(0, dev.index + 1) });
    }}><Trash2 size={12} /></button>}>
      <div className="history-list">
        {[...history].map((h, i) => ({ h, i })).reverse().map(({ h, i }) => (
          <div key={i} className={`hist-row${i === index ? ' active' : ''}${i > index ? ' future' : ''}`} onClick={() => jumpTo(i)}
            onMouseEnter={() => useDevelop.getState().setPreview(h.edit, h.label)} onMouseLeave={() => useDevelop.getState().setPreview(null)}>
            <span className="name">{h.label}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export { activePhoto };
