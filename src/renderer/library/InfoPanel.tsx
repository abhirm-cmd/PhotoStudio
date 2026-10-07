import React, { useEffect, useState } from 'react';
import { Heart, Flag, X, Tag, Sparkles, Wand2, Plus } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { Section, Stars, LABEL_COLORS } from '../components/ui';
import { setRating, setFlag, setLabel, toggleFavorite } from '../services/actions';
import { api } from '../api';
import { formatBytes, formatDate, formatShutter } from './format';
import { applyPresetToPhotos, autoEnhancePhotos } from '../services/batch';
import type { ColorLabel, IptcMeta, Photo, Preset } from '@shared/types';
import { analyzeAndTag } from '../analysis/tagging';

export function InfoPanel() {
  const photos = useLibrary(s => s.photos);
  const selection = useLibrary(s => s.selection);
  const activeId = useLibrary(s => s.activeId);
  const p = photos.find(x => x.id === activeId) ?? null;
  const sel = photos.filter(x => selection.includes(x.id));
  const targets = sel.length ? sel : p ? [p] : [];

  if (!p && !targets.length) {
    return <div className="panel-empty"><p className="dim small">Select a photo to see its details, rate it, and add keywords.</p></div>;
  }
  const many = targets.length > 1;
  return (
    <>
      <QuickDevelop targets={targets} />
      <Section id="lib.rate" title={many ? `Rate · ${targets.length} photos` : 'Rate & Flag'}>
        <div className="col">
          <div className="row between"><span className="muted">Rating</span><Stars value={p?.rating ?? 0} size={15} onChange={v => setRating(v, targets.map(t => t.id))} /></div>
          <div className="row between">
            <span className="muted">Flag</span>
            <div className="btn-row tight">
              <button className={`btn sm${p?.flag === 'pick' ? ' active' : ''}`} onClick={() => setFlag(p?.flag === 'pick' ? 'none' : 'pick', targets.map(t => t.id))}><Flag size={12} fill={p?.flag === 'pick' ? 'currentColor' : 'none'} />Pick</button>
              <button className={`btn sm${p?.flag === 'reject' ? ' active' : ''}`} onClick={() => setFlag(p?.flag === 'reject' ? 'none' : 'reject', targets.map(t => t.id))}><X size={12} />Reject</button>
              <button className={`icon-btn${p?.favorite ? ' active' : ''}`} onClick={() => toggleFavorite(targets.map(t => t.id))} aria-label="Favorite" title="Favorite"><Heart size={14} fill={p?.favorite ? 'currentColor' : 'none'} /></button>
            </div>
          </div>
          <div className="row between">
            <span className="muted">Label</span>
            <div className="row" style={{ gap: 6 }}>
              {(['red', 'yellow', 'green', 'blue', 'purple'] as ColorLabel[]).map(l => (
                <button key={l} className={`label-dot${p?.label === l ? ' on' : ''}`} style={{ background: LABEL_COLORS[l] }} onClick={() => setLabel(l, targets.map(t => t.id))} aria-label={`${l} label`} />
              ))}
            </div>
          </div>
        </div>
      </Section>
      <KeywordsSection targets={targets} />
      {p && !many && <IptcSection photo={p} />}
      {p && !many && <ExifSection photo={p} />}
    </>
  );
}

function QuickDevelop({ targets }: { targets: Photo[] }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pid, setPid] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.presets().then(setPresets); }, []);
  const ready = targets.filter(t => t.thumbState === 'ready');
  return (
    <Section id="lib.quick" title="Quick Develop">
      <div className="col">
        <button className="btn block" disabled={busy || !ready.length} onClick={async () => { setBusy(true); await autoEnhancePhotos(ready, 0.7); setBusy(false); }}>
          <Sparkles size={13} className="accent" />AI Auto Enhance{targets.length > 1 ? ` (${ready.length})` : ''}
        </button>
        <div className="row">
          <select className="input sm grow" value={pid} onChange={e => setPid(e.target.value)} aria-label="Preset">
            <option value="">Apply a preset…</option>
            {groupBy(presets, p => p.folder).map(([folder, list]) => (
              <optgroup key={folder} label={folder}>{list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            ))}
          </select>
          <button className="btn sm" disabled={!pid || !targets.length} onClick={() => { const pr = presets.find(x => x.id === pid); if (pr) applyPresetToPhotos(targets.map(t => t.id), pr); }}>Apply</button>
        </div>
        <button className="btn sm ghost block" disabled={busy || !ready.length} onClick={async () => { setBusy(true); await analyzeAndTag(ready); setBusy(false); }}>
          <Wand2 size={12} />Analyze & tag on this computer
        </button>
      </div>
    </Section>
  );
}

export function groupBy<T>(list: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return [...m.entries()];
}

function KeywordsSection({ targets }: { targets: Photo[] }) {
  const [text, setText] = useState('');
  const known = useLibrary(s => s.distinct.keywords);
  const ids = targets.map(t => t.id);
  const common = targets.length ? targets[0].keywords.filter(k => targets.every(t => t.keywords.includes(k))) : [];
  const ai = targets.length === 1 ? targets[0].aiTags : [];
  const add = async () => {
    const words = text.split(',').map(s => s.trim()).filter(Boolean);
    if (!words.length) return;
    await api.addKeywords(ids, words);
    setText('');
    useLibrary.getState().patchPhotos(ids, {});
    for (const t of targets) useLibrary.getState().patchPhotos([t.id], { keywords: [...new Set([...t.keywords, ...words])] });
    useLibrary.getState().refreshMeta();
  };
  const remove = async (k: string) => {
    await api.removeKeyword(ids, k);
    for (const t of targets) useLibrary.getState().patchPhotos([t.id], { keywords: t.keywords.filter(x => x !== k) });
    useLibrary.getState().refreshMeta();
  };
  return (
    <Section id="lib.keywords.edit" title="Keywords">
      <div className="chips mb8">
        {common.map(k => <span key={k} className="chip"><Tag size={10} />{k}<button onClick={() => remove(k)} aria-label={`Remove ${k}`}><X size={10} /></button></span>)}
        {!common.length && <span className="dim small">No keywords{targets.length > 1 ? ' shared by all selected photos' : ''}.</span>}
      </div>
      <div className="row">
        <input className="input sm grow" list="kw-list" placeholder="Add keywords, comma separated" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
        <datalist id="kw-list">{known.map(k => <option key={k} value={k} />)}</datalist>
        <button className="icon-btn" onClick={add} aria-label="Add keyword"><Plus size={14} /></button>
      </div>
      {ai.length > 0 && (
        <>
          <div className="subhead mt12">Detected on this computer <span className="tag local">Local</span></div>
          <div className="chips">
            {ai.map(k => <button key={k} className="chip" title="Add as keyword" onClick={() => api.addKeywords(ids, [k]).then(() => { useLibrary.getState().patchPhotos(ids, { keywords: [...new Set([...targets[0].keywords, k])] }); useLibrary.getState().refreshMeta(); })}><Sparkles size={10} />{k}</button>)}
          </div>
        </>
      )}
    </Section>
  );
}

function IptcSection({ photo }: { photo: Photo }) {
  const [m, setM] = useState<IptcMeta>(photo.iptc);
  useEffect(() => setM(photo.iptc), [photo.id]);
  const save = (k: keyof IptcMeta) => {
    if ((m[k] ?? '') === (photo.iptc[k] ?? '')) return;
    api.setIptc([photo.id], { [k]: m[k] });
    useLibrary.getState().patchPhotos([photo.id], { iptc: { ...photo.iptc, [k]: m[k] } });
  };
  const field = (k: keyof IptcMeta, label: string, multi = false) => (
    <div className="field">
      <label>{label}</label>
      {multi
        ? <textarea className="input" rows={2} value={m[k] ?? ''} onChange={e => setM({ ...m, [k]: e.target.value })} onBlur={() => save(k)} onKeyDown={e => e.stopPropagation()} />
        : <input className="input sm" value={m[k] ?? ''} onChange={e => setM({ ...m, [k]: e.target.value })} onBlur={() => save(k)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />}
    </div>
  );
  return (
    <Section id="lib.iptc" title="Metadata" defaultOpen={false}>
      {field('title', 'Title')}
      {field('caption', 'Caption', true)}
      {field('creator', 'Creator')}
      {field('copyright', 'Copyright')}
      {field('location', 'Location')}
      <p className="dim small">Stored in the catalog and written into exported files. Originals are never modified.</p>
    </Section>
  );
}

function ExifSection({ photo: p }: { photo: Photo }) {
  const e = p.exif;
  const rows: [string, string | undefined][] = [
    ['File', p.filename], ['Folder', p.folder], ['Format', `${p.ext.toUpperCase()}${p.isRaw ? ' (RAW)' : ''}`], ['Size', formatBytes(p.fileSize)],
    ['Dimensions', p.width && p.height ? `${p.width} × ${p.height}` : undefined], ['Captured', formatDate(e.dateTaken)],
    ['Camera', [e.make, e.model].filter(Boolean).join(' ') || undefined], ['Lens', e.lens], ['Focal length', e.focalLength ? `${Math.round(e.focalLength)} mm` : undefined],
    ['Aperture', e.aperture ? `f/${e.aperture}` : undefined], ['Shutter', formatShutter(e.shutter) || undefined], ['ISO', e.iso ? String(e.iso) : undefined],
    ['GPS', e.gps ? `${e.gps.lat.toFixed(5)}, ${e.gps.lon.toFixed(5)}` : undefined], ['Imported', formatDate(p.importedAt)], ['Edited', formatDate(p.editedAt)],
    ['Preset', p.presetName ?? undefined],
  ];
  return (
    <Section id="lib.exif" title="Camera Info">
      <dl className="kv">{rows.filter(r => r[1]).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd title={v}>{v}</dd></React.Fragment>)}</dl>
    </Section>
  );
}
