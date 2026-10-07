import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, Plus, Upload, Download, Sparkles, Folder, Images } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { SidePanel } from '../components/Panel';
import { Viewer } from '../develop/Viewer';
import { useEditorPhoto } from './Develop';
import { usePresets, reloadPresets, presetMenu } from '../develop/LeftPanels';
import { Section, Slider, Empty, openMenu } from '../components/ui';
import { presetEdit, applyPresetToPhotos } from '../services/batch';
import { offscreen, prepare, contextFor, loadMaskAssets } from '../services/offscreen';
import { computeGeometry } from '../engine/geometry';
import { encodeJpeg } from '../engine/host';
import { api } from '../api';
import { cloneEdit, normalizeEdit, type EditParams } from '@shared/edit';
import type { Photo, Preset } from '@shared/types';
import { groupBy } from '../library/InfoPanel';

/** Live preset thumbnails: every preset rendered on the active photo by the offscreen GPU renderer. */
const thumbCache = new Map<string, string>();
async function renderPresetThumb(photo: Photo, base: EditParams, preset: Preset): Promise<string> {
  const key = `${photo.id}:${JSON.stringify(base).length}:${hash(JSON.stringify(base))}:${preset.id}:${hash(JSON.stringify(preset.settings))}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const url = await offscreen(async r => {
    const src = await prepare(r, photo, 'preview', 1024);
    const e = presetEdit(base, preset);
    if (e.wb.mode === 'asShot') e.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
    const rc = contextFor(photo, e, src.width, src.height, await loadMaskAssets(e, photo.id));
    const g = computeGeometry(e, src.width, src.height, rc.lens);
    const out = r.render(e, rc, { scale: Math.min(1, 300 / Math.max(g.outW, g.outH)) }, 'pthumb');
    const jpg = await encodeJpeg(r.readEncoded(out, 'srgb', 8) as Uint8Array, out.width, out.height, 0.82);
    return URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
  });
  thumbCache.set(key, url);
  return url;
}
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

export function PresetsWorkspace() {
  const photo = useEditorPhoto();
  const presets = usePresets();
  const [folder, setFolder] = useState<string>('All');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Preset | null>(null);
  const [amount, setAmount] = useState(100);
  const [base, setBase] = useState<EditParams | null>(null);
  const selection = useLibrary(s => s.selection);
  const photoId = useDevelop(s => s.photoId);
  useEffect(() => { setSelected(null); setBase(null); setAmount(100); }, [photoId]);

  const folders = useMemo(() => ['All', 'Favorites', ...groupBy(presets, p => p.folder).map(([f]) => f)], [presets]);
  const list = presets.filter(p => (folder === 'All' || (folder === 'Favorites' ? p.favorite : p.folder === folder)) && (!q || `${p.name} ${p.folder}`.toLowerCase().includes(q.toLowerCase())));

  const apply = (p: Preset) => {
    const dev = useDevelop.getState();
    if (dev.photoId == null) return;
    const b = base && selected ? base : cloneEdit(dev.edit);
    dev.setPreview(null);
    dev.replaceEdit(presetEdit(b, p), `Preset: ${p.name}`, { presetName: p.name });
    setBase(b); setSelected(p); setAmount(100);
  };

  if (!photo) return <div className="center"><Empty kind="presets" title="Select a photo to preview presets"><p>Presets are previewed live on the selected photo.</p></Empty></div>;

  return (
    <>
      <SidePanel side="left">
        <Section id="presets.folders" title="Folders">
          {folders.map(f => (
            <div key={f} className={`nav-item${folder === f ? ' active' : ''}`} onClick={() => setFolder(f)} role="button">
              {f === 'Favorites' ? <Star size={14} /> : f === 'All' ? <Images size={14} /> : f === 'AI Enhanced' ? <Sparkles size={14} /> : <Folder size={14} />}
              <span className="name">{f}</span>
              <span className="count">{f === 'All' ? presets.length : f === 'Favorites' ? presets.filter(p => p.favorite).length : presets.filter(p => p.folder === f).length}</span>
            </div>
          ))}
        </Section>
        <Section id="presets.manage" title="Manage">
          <div className="col">
            <button className="btn sm" onClick={() => useApp.getState().openModal('savePreset')}><Plus size={12} />Create from current settings</button>
            <button className="btn sm" onClick={async () => { const n = await api.importPresets(); await reloadPresets(); useApp.getState().toast({ kind: 'success', title: `Imported ${n.length} preset${n.length === 1 ? '' : 's'}` }); }}><Upload size={12} />Import presets…</button>
            <button className="btn sm" onClick={async () => { const f = await api.exportPresets(presets.filter(p => !p.builtin)); if (f) useApp.getState().toast({ kind: 'success', title: 'Presets exported', body: f }); }}><Download size={12} />Export my presets…</button>
          </div>
        </Section>
      </SidePanel>
      <div className="center">
        <Viewer photo={photo} />
        {selected && (
          <div className="preset-bar">
            <span className="text-0">{selected.name}</span>
            <div style={{ width: 260 }}>
              <Slider label="Amount" min={0} max={200} defaultValue={100} value={amount} format={v => `${Math.round(v)}%`}
                onChange={v => { setAmount(v); if (base) useDevelop.getState().setEdit(() => presetEdit(base, selected, v / 100)); }}
                onCommit={v => useDevelop.getState().commit(`Preset: ${selected.name} ${Math.round(v)}%`)} />
            </div>
            {selection.length > 1 && <button className="btn sm" onClick={() => applyPresetToPhotos(selection.filter(id => id !== photoId), selected, amount / 100)}>Apply to {selection.length - 1} other selected</button>}
          </div>
        )}
      </div>
      <SidePanel side="right" header={
        <div className="toolstrip"><div className="search sm grow"><Search size={12} /><input className="input sm" placeholder="Search presets" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} /></div></div>
      }>
        <div className="preset-grid">
          {list.map(p => <PresetCard key={p.id} photo={photo} preset={p} active={selected?.id === p.id} onApply={() => apply(p)} />)}
        </div>
        {!list.length && <Empty kind="presets" title="No presets here" small><p>Create one from your current settings, or import presets.</p></Empty>}
      </SidePanel>
    </>
  );
}

function PresetCard({ photo, preset, active, onApply }: { photo: Photo; preset: Preset; active: boolean; onApply(): void }) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const committed = useDevelop(s => s.committed);
  // The thumbnail shows the preset applied on top of the photo's state before any preset was clicked here
  const base = useRef<EditParams | null>(null);
  if (!base.current) base.current = cloneEdit(committed);
  useEffect(() => {
    let alive = true;
    const el = ref.current!;
    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      api.getEdit(photo.id).then(saved => renderPresetThumb(photo, normalizeEdit(saved ?? base.current, photo.isRaw), preset)).then(u => { if (alive) setUrl(u); }).catch(() => {});
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [photo.id, preset.id, preset.settings]);
  return (
    <div ref={ref} className={`preset-card${active ? ' active' : ''}`} onClick={onApply}
      onMouseEnter={() => { const dev = useDevelop.getState(); dev.setPreview(presetEdit(dev.edit, preset), preset.name); }}
      onMouseLeave={() => useDevelop.getState().setPreview(null)}
      onContextMenu={e => openMenu(e, presetMenu(preset))} title={preset.source?.note ?? preset.name} role="button" tabIndex={0}>
      <div className="preset-thumb">{url ? <img src={url} alt="" /> : <div className="skeleton" />}</div>
      <div className="preset-name">{preset.favorite && <Star size={10} className="accent" fill="currentColor" />}<span>{preset.name}</span></div>
      <div className="preset-folder-name">{preset.folder}</div>
    </div>
  );
}
