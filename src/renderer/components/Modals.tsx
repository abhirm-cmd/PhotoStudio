import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Files, Plus, Trash2, HardDriveDownload, RotateCcw, Keyboard, Save, Filter, Import, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { useApp } from '../store/app';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { Modal, Seg, Kbd, confirmDialog, Progress } from './ui';
import { api } from '../api';
import { usePresets, reloadPresets } from '../develop/LeftPanels';
import { formatBytes, formatDate } from '../library/format';
import { DEFAULT_SHORTCUTS, SHORTCUT_LABELS, normalizeCombo } from '@shared/shortcuts';
import { SETTING_GROUPS, ALL_GROUPS, DEFAULT_PRESET_GROUPS, pickGroups, type SettingGroup } from '@shared/edit';
import type { AppSettings, BackupInfo, Collection, SmartField, SmartOp, SmartRule, SmartRuleSet } from '@shared/types';

export function Modals() {
  const modal = useApp(s => s.modal);
  const props = useApp(s => s.modalProps);
  const close = useApp(s => s.closeModal);
  switch (modal) {
    case 'import': return <ImportModal paths={props?.paths} onClose={close} />;
    case 'settings': return <SettingsModal tab={props?.tab} onClose={close} />;
    case 'restore': return <SettingsModal tab="catalog" onClose={close} />;
    case 'shortcuts': return <ShortcutsModal onClose={close} />;
    case 'smartCollection': return <SmartCollectionModal collection={props?.collection ?? null} onClose={close} />;
    case 'savePreset': return <SavePresetModal onClose={close} />;
    case 'syncSettings': case 'pasteSettings': return <SyncSettingsModal onClose={close} />;
    default: return null;
  }
}

/* ------------------------------------------------------------------ import */

function ImportModal({ paths: initial, onClose }: { paths?: string[]; onClose(): void }) {
  const [paths, setPaths] = useState<string[]>(initial ?? []);
  const [recursive, setRecursive] = useState(true);
  const [mode, setMode] = useState<'reference' | 'copy'>('reference');
  const [destination, setDestination] = useState<string>('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [keywords, setKeywords] = useState('');
  const [presetId, setPresetId] = useState<string>('');
  const [count, setCount] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const presets = usePresets();

  useEffect(() => {
    if (!paths.length) { setCount(0); return; }
    let alive = true;
    setCount(null);
    api.scanCount(paths, recursive).then(n => { if (alive) setCount(n); }).catch(() => alive && setCount(0));
    return () => { alive = false; };
  }, [paths, recursive]);

  const add = async (kind: 'files' | 'folder') => {
    const p = await api.pickImport(kind);
    if (p.length) setPaths(cur => [...new Set([...cur, ...p])]);
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.startImport({
        paths, recursive, mode, destination: mode === 'copy' ? destination : undefined, skipDuplicates,
        keywords: keywords.split(',').map(s => s.trim()).filter(Boolean), applyPresetId: presetId || null,
      });
      onClose();
    } catch (err: any) {
      useApp.getState().toast({ kind: 'error', title: 'Import could not start', body: String(err?.message ?? err) });
      setStarting(false);
    }
  };

  const canStart = paths.length > 0 && (count ?? 0) > 0 && (mode === 'reference' || !!destination) && !starting;

  return (
    <Modal title="Import photos" icon={<Import size={16} />} onClose={onClose} footer={<>
      <span className="grow text-1">{count == null ? 'Scanning…' : `${count} supported photo${count === 1 ? '' : 's'} found`}</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!canStart} onClick={start}>Import {count ? count : ''}</button>
    </>}>
      <div className="field">
        <label>Source</label>
        <div className="import-paths">
          {paths.length ? paths.map(p => (
            <div key={p} className="import-path"><span className="grow ellipsis" title={p}>{p}</span>
              <button className="icon-btn" aria-label={`Remove ${p}`} onClick={() => setPaths(paths.filter(x => x !== p))}><Trash2 size={12} /></button></div>
          )) : <div className="text-1 pad">Choose files or a folder, or drop them on the window.</div>}
        </div>
        <div className="btn-row"><button className="btn sm" onClick={() => add('folder')}><FolderOpen size={12} />Add folder…</button><button className="btn sm" onClick={() => add('files')}><Files size={12} />Add files…</button></div>
        <label className="check"><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />Include subfolders</label>
      </div>
      <div className="field">
        <label>File handling</label>
        <Seg value={mode} onChange={setMode} options={[{ value: 'reference', label: 'Add (leave files where they are)' }, { value: 'copy', label: 'Copy to a folder' }]} />
        {mode === 'copy' && (
          <div className="row"><input className="input" readOnly value={destination} placeholder="Destination folder" />
            <button className="btn" onClick={async () => { const d = await api.pickFolder('Copy photos to'); if (d) setDestination(d); }}>Choose…</button></div>
        )}
        <p className="text-1 small">Originals are never modified. Edits are stored in the catalog.</p>
      </div>
      <div className="field">
        <label className="check"><input type="checkbox" checked={skipDuplicates} onChange={e => setSkipDuplicates(e.target.checked)} />Skip photos already in the catalog</label>
      </div>
      <div className="field"><label>Add keywords (comma separated)</label><input className="input" value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="e.g. wedding, Anna & Ben" onKeyDown={e => e.stopPropagation()} /></div>
      <div className="field"><label>Apply preset on import</label>
        <select className="input" value={presetId} onChange={e => setPresetId(e.target.value)}>
          <option value="">None</option>
          {presets.map(p => <option key={p.id} value={p.id}>{p.folder} › {p.name}</option>)}
        </select>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- settings */

type SettingsTab = 'general' | 'performance' | 'catalog' | 'ai' | 'color' | 'shortcuts';

function SettingsModal({ tab: initial, onClose }: { tab?: SettingsTab; onClose(): void }) {
  const [tab, setTab] = useState<SettingsTab>(initial ?? 'general');
  const settings = useApp(s => s.settings);
  const update = useApp(s => s.updateSettings);
  if (!settings) return null;
  const tabs: [SettingsTab, string][] = [['general', 'General'], ['performance', 'Performance'], ['catalog', 'Catalog & Backup'], ['ai', 'AI & Privacy'], ['color', 'Color'], ['shortcuts', 'Shortcuts']];
  return (
    <Modal title="Settings" icon={<SettingsIcon size={16} />} wide onClose={onClose}>
      <div className="settings">
        <nav className="settings-nav">{tabs.map(([id, label]) => <button key={id} className={`nav-item${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <div className="settings-body">
          {tab === 'general' && <>
            <div className="field-row"><label>Theme</label><Seg value={settings.general.theme} onChange={v => update({ general: { theme: v } })} options={[{ value: 'dark', label: 'Dark' }, { value: 'darker', label: 'Darker' }, { value: 'high-contrast', label: 'High contrast' }]} /></div>
            <div className="field-row"><label>Interface size</label>
              <select className="input" value={settings.general.uiScale} onChange={e => update({ general: { uiScale: Number(e.target.value) } })}>
                {[0.9, 1, 1.1, 1.25, 1.4].map(v => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
              </select></div>
            <label className="check"><input type="checkbox" checked={settings.general.confirmDeletes} onChange={e => update({ general: { confirmDeletes: e.target.checked } })} />Ask before removing photos from the catalog</label>
          </>}
          {tab === 'performance' && <PerformanceTab settings={settings} update={update} />}
          {tab === 'catalog' && <CatalogTab settings={settings} update={update} />}
          {tab === 'ai' && <>
            <div className="field-row"><label>AI features</label><Seg value={settings.ai.provider === 'off' ? 'off' : 'local'} onChange={v => update({ ai: { provider: v } })} options={[{ value: 'local', label: 'On this device' }, { value: 'off', label: 'Off' }]} /></div>
            <label className="check"><input type="checkbox" checked={settings.ai.analyzeOnImport} disabled={settings.ai.provider === 'off'} onChange={e => update({ ai: { analyzeOnImport: e.target.checked } })} />Analyse and tag new photos after import</label>
            <div className="notice"><ShieldCheck size={14} /><div>All analysis (auto enhance, masks, scene tags, reference grading) runs locally. Lumora does not upload photos anywhere. If a cloud option is ever added, it will ask for your permission before any image leaves this computer.</div></div>
          </>}
          {tab === 'color' && <>
            <div className="field-row"><label>Display</label><Seg value={settings.color.displayProfile} onChange={v => update({ color: { displayProfile: v } })} options={[{ value: 'srgb', label: 'sRGB' }, { value: 'display-p3', label: 'Display P3' }]} /></div>
            <p className="text-1 small">Choose Display P3 on wide-gamut screens (most recent Macs and many laptops). Editing always happens in a linear Rec. 2020 working space, so this only changes how the preview is shown.</p>
          </>}
          {tab === 'shortcuts' && <ShortcutEditor />}
        </div>
      </div>
    </Modal>
  );
}

function PerformanceTab({ settings, update }: { settings: AppSettings; update(p: any): Promise<void> }) {
  const [cache, setCache] = useState<number | null>(null);
  useEffect(() => { api.cacheSize().then(setCache).catch(() => {}); }, []);
  return <>
    <div className="field-row"><label>Preview size</label>
      <select className="input" value={settings.performance.previewLongEdge} onChange={e => update({ performance: { previewLongEdge: Number(e.target.value) } })}>
        {[1600, 2048, 2560, 3200, 4096].map(v => <option key={v} value={v}>{v} px{v === 2560 ? ' (default)' : v > 2560 ? ' (sharper zoom, more memory)' : ' (faster)'}</option>)}
      </select></div>
    <p className="text-1 small">The editing preview is rendered on the GPU at this size. Export always renders at full resolution.</p>
    <div className="field-row"><label>Preview cache</label><span className="grow">{cache == null ? '…' : formatBytes(cache)}</span>
      <button className="btn sm" onClick={async () => { if (await confirmDialog('Clear preview cache?', 'Previews and thumbnails are rebuilt on demand. Your photos and edits are not affected.')) { await api.clearCache(); setCache(await api.cacheSize()); } }}>Clear</button></div>
  </>;
}

function CatalogTab({ settings, update }: { settings: AppSettings; update(p: any): Promise<void> }) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp(s => s.toast);
  const reload = () => api.backups().then(setBackups).catch(() => setBackups([]));
  useEffect(() => { reload(); }, []);
  return <>
    <div className="field-row"><label>Catalog</label><span className="grow ellipsis selectable" title={settings.catalog.location}>{settings.catalog.location}</span><button className="btn sm" onClick={() => api.revealPath(settings.catalog.location)}>Show</button></div>
    <div className="field-row"><label>Backups in</label><span className="grow ellipsis selectable" title={settings.catalog.backupLocation}>{settings.catalog.backupLocation}</span>
      <button className="btn sm" onClick={async () => { const d = await api.pickFolder('Backup folder'); if (d) update({ catalog: { backupLocation: d } }); }}>Change…</button></div>
    <div className="field-row"><label>Automatic</label>
      <select className="input" value={settings.catalog.autoBackup} onChange={e => update({ catalog: { autoBackup: e.target.value } })}>
        <option value="never">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="on-exit">When quitting</option>
      </select></div>
    <div className="field-row"><label>Keep</label>
      <select className="input" value={settings.catalog.keepBackups} onChange={e => update({ catalog: { keepBackups: Number(e.target.value) } })}>
        {[3, 5, 10, 20, 50].map(n => <option key={n} value={n}>{n} most recent</option>)}
      </select></div>
    <div className="row between mt8"><span className="field-label">Backups</span>
      <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { await api.backupNow(); toast({ kind: 'success', title: 'Catalog backed up' }); await reload(); } finally { setBusy(false); } }}><HardDriveDownload size={12} />Back up now</button></div>
    {busy && <Progress indeterminate />}
    <div className="backup-list">
      {backups == null ? <div className="text-1 pad">Loading…</div> : !backups.length ? <div className="text-1 pad">No backups yet.</div> : backups.map(b => (
        <div key={b.path} className="backup-row">
          <span className="grow">{formatDate(b.createdAt, true)}</span><span className="text-1">{formatBytes(b.sizeBytes)}</span>
          <button className="btn sm" onClick={async () => {
            if (!(await confirmDialog('Restore this backup?', 'The current catalog is backed up first, then replaced by this backup and the app reloads. Original photo files are never touched.', { okLabel: 'Restore', danger: true }))) return;
            await api.restoreBackup(b.path);
          }}><RotateCcw size={12} />Restore</button>
        </div>
      ))}
    </div>
  </>;
}

function ShortcutEditor() {
  const settings = useApp(s => s.settings)!;
  const update = useApp(s => s.updateSettings);
  const map = { ...DEFAULT_SHORTCUTS, ...settings.shortcuts };
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const isMac = api.platform() === 'darwin';

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setEditing(null); return; }
      const combo = normalizeCombo(e, isMac);
      if (!combo || ['Mod', 'Shift', 'Alt', 'Ctrl'].includes(combo.split('+').pop()!)) return;
      const next = { ...map };
      const clash = Object.entries(next).find(([k, v]) => v === combo && k !== editing);
      if (clash) {
        next[clash[0]] = '';
        useApp.getState().toast({ kind: 'info', title: `${combo} was used by “${SHORTCUT_LABELS[clash[0]] ?? clash[0]}”`, body: 'That action now has no shortcut.' });
      }
      next[editing] = combo;
      update({ shortcuts: next });
      setEditing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing]);

  const rows = Object.keys(DEFAULT_SHORTCUTS).filter(k => !q || (SHORTCUT_LABELS[k] ?? k).toLowerCase().includes(q.toLowerCase()) || (map[k] ?? '').toLowerCase().includes(q.toLowerCase()));
  return <>
    <div className="row"><input className="input grow" placeholder="Search shortcuts" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} />
      <button className="btn sm" onClick={async () => { if (await confirmDialog('Reset all shortcuts?', 'Every shortcut returns to its default.')) update({ shortcuts: { ...DEFAULT_SHORTCUTS } }); }}>Reset all</button></div>
    <div className="shortcut-list">
      {rows.map(k => (
        <div key={k} className="shortcut-row">
          <span className="grow">{SHORTCUT_LABELS[k] ?? k}</span>
          <button className={`btn sm shortcut-key${editing === k ? ' active' : ''}`} onClick={() => setEditing(editing === k ? null : k)} title="Click, then press the new key combination">
            {editing === k ? 'Press keys… (Esc to cancel)' : map[k] ? <Kbd combo={map[k]} /> : <span className="text-1">None</span>}
          </button>
          {map[k] !== DEFAULT_SHORTCUTS[k] && <button className="icon-btn" title="Restore default" onClick={() => update({ shortcuts: { ...map, [k]: DEFAULT_SHORTCUTS[k] } })}><RotateCcw size={12} /></button>}
        </div>
      ))}
    </div>
  </>;
}

/* --------------------------------------------------------------- shortcuts */

function ShortcutsModal({ onClose }: { onClose(): void }) {
  const map = { ...DEFAULT_SHORTCUTS, ...(useApp(s => s.settings?.shortcuts) ?? {}) };
  const groups: [string, string][] = [['workspace', 'Workspaces'], ['view', 'View'], ['tool', 'Tools'], ['edit', 'Editing'], ['flag', 'Flags'], ['rate', 'Ratings'], ['label', 'Color labels'], ['favorite', 'Favorites'], ['nav', 'Navigation'], ['library', 'Library'], ['app', 'App']];
  return (
    <Modal title="Keyboard shortcuts" icon={<Keyboard size={16} />} wide onClose={onClose} footer={<>
      <span className="grow text-1">Masking: [ and ] resize the brush, O toggles the mask overlay. Hold Alt while brushing to erase.</span>
      <button className="btn" onClick={() => useApp.getState().openModal('settings', { tab: 'shortcuts' })}>Customize…</button>
    </>}>
      <div className="shortcut-columns">
        {groups.map(([prefix, title]) => (
          <div key={prefix} className="shortcut-group">
            <div className="subhead">{title}</div>
            {Object.keys(DEFAULT_SHORTCUTS).filter(k => k.startsWith(prefix + '.') && map[k]).map(k => (
              <div key={k} className="shortcut-row"><span className="grow">{SHORTCUT_LABELS[k] ?? k}</span><Kbd combo={map[k]} /></div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- smart collection */

const FIELDS: { field: SmartField; label: string; type: 'number' | 'text' | 'enum' | 'bool' | 'date'; options?: string[]; ops: SmartOp[] }[] = [
  { field: 'rating', label: 'Rating', type: 'number', ops: ['gte', 'lte', 'is'] },
  { field: 'flag', label: 'Flag', type: 'enum', options: ['pick', 'reject', 'none'], ops: ['is', 'isNot'] },
  { field: 'label', label: 'Color label', type: 'enum', options: ['red', 'yellow', 'green', 'blue', 'purple', 'none'], ops: ['is', 'isNot'] },
  { field: 'favorite', label: 'Favorite', type: 'bool', ops: ['is'] },
  { field: 'keyword', label: 'Keyword', type: 'text', ops: ['contains', 'is', 'notContains'] },
  { field: 'aiTag', label: 'Scene tag', type: 'text', ops: ['is', 'isNot'] },
  { field: 'camera', label: 'Camera', type: 'text', ops: ['contains', 'is', 'notContains'] },
  { field: 'lens', label: 'Lens', type: 'text', ops: ['contains', 'is', 'notContains'] },
  { field: 'iso', label: 'ISO', type: 'number', ops: ['gte', 'lte', 'is', 'between'] },
  { field: 'aperture', label: 'Aperture (f/)', type: 'number', ops: ['gte', 'lte', 'between'] },
  { field: 'focalLength', label: 'Focal length (mm)', type: 'number', ops: ['gte', 'lte', 'between'] },
  { field: 'date', label: 'Capture date', type: 'date', ops: ['gte', 'lte', 'between'] },
  { field: 'folder', label: 'Folder', type: 'text', ops: ['contains', 'notContains'] },
  { field: 'filename', label: 'File name', type: 'text', ops: ['contains', 'notContains'] },
  { field: 'fileType', label: 'File type', type: 'text', ops: ['is', 'isNot'] },
  { field: 'isRaw', label: 'Is RAW', type: 'bool', ops: ['is'] },
  { field: 'edited', label: 'Has edits', type: 'bool', ops: ['is'] },
  { field: 'aiEnhanced', label: 'AI enhanced', type: 'bool', ops: ['is'] },
  { field: 'preset', label: 'Preset applied', type: 'text', ops: ['contains', 'is'] },
];
const OP_LABEL: Record<SmartOp, string> = { is: 'is', isNot: 'is not', gte: 'at least', lte: 'at most', contains: 'contains', notContains: 'does not contain', between: 'between' };

function SmartCollectionModal({ collection, onClose }: { collection: Collection | null; onClose(): void }) {
  const [name, setName] = useState(collection?.name ?? 'Smart Collection');
  const [set, setSet] = useState<SmartRuleSet>(collection?.rules ?? { match: 'all', rules: [{ field: 'rating', op: 'gte', value: 4 }] });
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => api.queryPhotos({ rules: set }).then(r => { if (alive) setCount(r.length); }).catch(() => {}), 200);
    return () => { alive = false; clearTimeout(t); };
  }, [set]);
  const patch = (i: number, r: Partial<SmartRule>) => setSet(s => ({ ...s, rules: s.rules.map((x, j) => (j === i ? { ...x, ...r } : x)) }));
  const save = async () => {
    if (collection) await api.updateCollection(collection.id, { name, rules: set });
    else await api.createCollection(name, 'smart', set);
    await useLibrary.getState().refreshMeta();
    useLibrary.getState().refresh();
    onClose();
  };
  return (
    <Modal title={collection ? 'Edit smart collection' : 'New smart collection'} icon={<Filter size={16} />} onClose={onClose} footer={<>
      <span className="grow text-1">{count == null ? 'Counting…' : `${count} matching photo${count === 1 ? '' : 's'} now`}</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim()} onClick={save}>{collection ? 'Save' : 'Create'}</button>
    </>}>
      <div className="field"><label>Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} autoFocus /></div>
      <div className="row mt8">Match <select className="input" style={{ width: 90 }} value={set.match} onChange={e => setSet({ ...set, match: e.target.value as any })}><option value="all">all</option><option value="any">any</option></select> of these rules:</div>
      <div className="rules">
        {set.rules.map((r, i) => {
          const f = FIELDS.find(x => x.field === r.field)!;
          const input = (val: any, key: 'value' | 'value2') => f.type === 'enum'
            ? <select className="input" value={val} onChange={e => patch(i, { [key]: e.target.value })}>{f.options!.map(o => <option key={o} value={o}>{o}</option>)}</select>
            : f.type === 'bool' ? <select className="input" value={String(!!val)} onChange={e => patch(i, { [key]: e.target.value === 'true' })}><option value="true">yes</option><option value="false">no</option></select>
            : <input className="input" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={val ?? ''} onKeyDown={e => e.stopPropagation()}
                onChange={e => patch(i, { [key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />;
          return (
            <div key={i} className="rule-row">
              <select className="input" value={r.field} onChange={e => { const nf = FIELDS.find(x => x.field === e.target.value)!; patch(i, { field: nf.field, op: nf.ops[0], value: nf.type === 'bool' ? true : nf.type === 'enum' ? nf.options![0] : nf.type === 'number' ? 0 : '', value2: undefined }); }}>
                {FIELDS.map(x => <option key={x.field} value={x.field}>{x.label}</option>)}
              </select>
              <select className="input" value={r.op} onChange={e => patch(i, { op: e.target.value as SmartOp })}>{f.ops.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
              {input(r.value, 'value')}
              {r.op === 'between' && <>and {input(r.value2, 'value2')}</>}
              <button className="icon-btn" aria-label="Remove rule" onClick={() => setSet(s => ({ ...s, rules: s.rules.filter((_, j) => j !== i) }))}><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
      <button className="btn sm" onClick={() => setSet(s => ({ ...s, rules: [...s.rules, { field: 'keyword', op: 'contains', value: '' }] }))}><Plus size={12} />Add rule</button>
    </Modal>
  );
}

/* -------------------------------------------------------------- save preset */

function GroupChecks({ groups, setGroups, exclude = [] }: { groups: SettingGroup[]; setGroups(g: SettingGroup[]): void; exclude?: SettingGroup[] }) {
  const all = ALL_GROUPS.filter(g => !exclude.includes(g));
  return (
    <div className="group-checks">
      <div className="row between"><span className="field-label">Include</span>
        <span className="btn-row tight"><button className="btn sm ghost" onClick={() => setGroups(all)}>All</button><button className="btn sm ghost" onClick={() => setGroups([])}>None</button></span></div>
      <div className="check-grid">
        {all.map(g => (
          <label key={g} className="check"><input type="checkbox" checked={groups.includes(g)} onChange={e => setGroups(e.target.checked ? [...groups, g] : groups.filter(x => x !== g))} />{SETTING_GROUPS[g].label}</label>
        ))}
      </div>
    </div>
  );
}

function SavePresetModal({ onClose }: { onClose(): void }) {
  const presets = usePresets();
  const folders = useMemo(() => [...new Set(presets.filter(p => !p.builtin).map(p => p.folder))], [presets]);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(folders[0] ?? 'My Presets');
  const [groups, setGroups] = useState<SettingGroup[]>(DEFAULT_PRESET_GROUPS.filter(g => g !== 'whiteBalance'));
  const photoId = useDevelop(s => s.photoId);
  const save = async () => {
    const edit = useDevelop.getState().edit;
    await api.savePreset({ id: `user-${crypto.randomUUID()}`, name: name.trim(), folder: folder.trim() || 'My Presets', favorite: false, builtin: false, groups, settings: pickGroups(edit, groups), createdAt: new Date().toISOString(), source: { kind: 'user' } });
    await reloadPresets();
    useApp.getState().toast({ kind: 'success', title: `Saved preset “${name.trim()}”` });
    onClose();
  };
  return (
    <Modal title="New preset from current settings" icon={<Save size={16} />} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim() || !groups.length || photoId == null} onClick={save}>Save preset</button>
    </>}>
      {photoId == null && <div className="notice">Open a photo first; the preset is made from its current settings.</div>}
      <div className="field"><label>Name</label><input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && name.trim()) save(); }} /></div>
      <div className="field"><label>Folder</label><input className="input" list="preset-folders" value={folder} onChange={e => setFolder(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        <datalist id="preset-folders">{folders.map(f => <option key={f} value={f} />)}</datalist></div>
      <GroupChecks groups={groups} setGroups={setGroups} />
      <p className="text-1 small">White balance, crop, transform and masks are usually photo-specific; include them only if you want them copied exactly.</p>
    </Modal>
  );
}

/* ------------------------------------------------------------- sync settings */

function SyncSettingsModal({ onClose }: { onClose(): void }) {
  const selection = useLibrary(s => s.selection);
  const photoId = useDevelop(s => s.photoId);
  const targets = selection.filter(id => id !== photoId);
  const [groups, setGroups] = useState<SettingGroup[]>(ALL_GROUPS.filter(g => !['crop', 'masks', 'transform'].includes(g)));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const dev = useDevelop.getState();
      dev.copySettings(groups);
      const n = await dev.pasteSettings(targets, groups);
      useApp.getState().toast({ kind: 'success', title: `Synced settings to ${n} photo${n === 1 ? '' : 's'}`, body: 'Each change is in that photo’s history and can be undone.' });
      onClose();
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Sync settings" icon={<RotateCcw size={16} />} onClose={onClose} footer={<>
      <span className="grow text-1">{photoId == null ? 'Open a photo to sync from.' : targets.length ? `From the active photo to ${targets.length} other selected photo${targets.length === 1 ? '' : 's'}` : 'Select more photos in the filmstrip or grid to sync to.'}</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !targets.length || !groups.length || photoId == null} onClick={run}>Sync</button>
    </>}>
      <GroupChecks groups={groups} setGroups={setGroups} />
    </Modal>
  );
}
