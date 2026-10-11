/** Project media bin: import, browse, preview in the source monitor, drag to the timeline, relink offline files. */
import React, { useMemo, useState } from 'react';
import { FolderPlus, FilePlus2, Search, LayoutGrid, List, Film, Music, Image as ImageIcon, AlertTriangle, Link as LinkIcon } from 'lucide-react';
import { type MediaItem } from '@shared/project';
import { useProject } from '../store/project';
import { usePlayer } from '../store/player';
import { useUI } from '../store/ui';
import { api, cacheUrl } from '../api';
import { importDialog, importPaths, relink } from '../services/media';
import { appendMedia } from '../services/actions';
import { Empty, openMenu, confirmDialog } from './ui';
import { MEDIA_DND } from '../timeline/Timeline';

const fmtDur = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`; };
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

export function Poster({ m, big }: { m: MediaItem; big?: boolean }) {
  const th = m.thumbs;
  if (m.kind === 'audio') return <div className="poster audio"><Music size={big ? 28 : 18} /></div>;
  if (!th) return <div className="poster skeleton" />;
  // Middle tile of the filmstrip sprite
  const idx = Math.floor(th.count / 2);
  return <div className="poster" style={{ backgroundImage: `url("${cacheUrl(th.key)}")`, backgroundSize: `${th.count * 100}% 100%`, backgroundPosition: th.count > 1 ? `${(idx / (th.count - 1)) * 100}% 0` : '0 0', aspectRatio: `${th.width} / ${th.height}` }} />;
}

export function MediaBin({ compact }: { compact?: boolean }) {
  const media = useProject(s => s.project.media);
  const clips = useProject(s => s.project.clips);
  const selected = useProject(s => s.selectedMediaId);
  const tasks = useUI(s => s.tasks);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>(compact ? 'list' : 'grid');
  const [over, setOver] = useState(false);
  const used = useMemo(() => { const u = new Map<string, number>(); for (const c of clips) if (c.mediaId) u.set(c.mediaId, (u.get(c.mediaId) ?? 0) + 1); return u; }, [clips]);
  const shown = media.filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  const open = (m: MediaItem) => { usePlayer.getState().setSource(m.id); useProject.getState().selectMedia(m.id); useUI.getState().setActiveMonitor('source'); };
  const remove = async (m: MediaItem) => {
    const n = used.get(m.id) ?? 0;
    if (n && !(await confirmDialog(`Remove ${m.name}?`, `${n} clip${n > 1 ? 's' : ''} on the timeline use${n > 1 ? '' : 's'} it and will be removed too. The file on disk is not touched.`, { okLabel: 'Remove', danger: true }))) return;
    useProject.getState().edit('Remove media', p => { p.media = p.media.filter(x => x.id !== m.id); p.clips = p.clips.filter(c => c.mediaId !== m.id); });
    if (usePlayer.getState().sourceId === m.id) usePlayer.getState().setSource(null);
  };
  const menu = (e: React.MouseEvent, m: MediaItem) => openMenu(e, [
    { label: 'Open in source monitor', onClick: () => open(m) },
    { label: 'Append to timeline', disabled: m.missing, onClick: () => appendMedia(m.id) },
    { sep: true },
    ...(m.missing ? [{ label: 'Relink…', icon: <LinkIcon size={13} />, onClick: () => relink(m) }] : [{ label: 'Show in folder', onClick: () => api.reveal(m.path) }]),
    { sep: true },
    { label: 'Remove from project', danger: true, onClick: () => remove(m) },
  ]);
  const drag = (e: React.DragEvent, m: MediaItem) => {
    if (m.missing) { e.preventDefault(); return; }
    e.dataTransfer.setData(MEDIA_DND, JSON.stringify({ mediaId: m.id }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const dropFiles = async (e: React.DragEvent) => {
    setOver(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    await importPaths([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
  };
  const busy = Object.values(tasks).filter(t => t.id.startsWith('an:') || t.id === 'import');

  return (
    <div className={`bin${over ? ' over' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={dropFiles}>
      <div className="bin-bar">
        <span className="mon-title">Media</span>
        <span className="dim small">{media.length}</span>
        <span className="grow" />
        <button className="icon-btn" title="Import files (Ctrl/⌘+I)" onClick={() => importDialog('files')} data-testid="import"><FilePlus2 size={14} /></button>
        <button className="icon-btn" title="Import a folder" onClick={() => importDialog('folder')}><FolderPlus size={14} /></button>
        {!compact && <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Thumbnails"><LayoutGrid size={12} /></button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List"><List size={12} /></button>
        </div>}
      </div>
      {media.length > 0 && <div className="bin-search search"><Search size={13} /><input className="input sm" placeholder="Search media" value={q} onChange={e => setQ(e.target.value)} /></div>}
      {busy.length > 0 && <div className="bin-busy"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /><span className="nm">{busy[0].label}</span>{busy[0].progress != null && <span className="dim">{Math.round(busy[0].progress * 100)}%</span>}{busy.length > 1 && <span className="dim">+{busy.length - 1}</span>}</div>}
      <div className={`bin-items ${view}`}>
        {!media.length && (
          <Empty kind="media" title="Import footage" small={compact}>
            <p>Drop video, audio and images here, or import them. Files stay where they are; the project only references them.</p>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => importDialog('files')}><FilePlus2 size={14} />Import media</button>
              <button className="btn" onClick={() => importDialog('folder')}><FolderPlus size={14} />Folder</button>
            </div>
          </Empty>
        )}
        {shown.map(m => (
          <div key={m.id} className={`bin-item${selected === m.id ? ' selected' : ''}${m.missing ? ' offline' : ''}`} draggable={!m.missing} onDragStart={e => drag(e, m)}
            onClick={() => useProject.getState().selectMedia(m.id)} onDoubleClick={() => open(m)} onContextMenu={e => menu(e, m)} data-media={m.name} title={m.path}>
            <div className="bi-poster"><Poster m={m} />{m.kind !== 'image' && <span className="bi-dur">{fmtDur(m.duration)}</span>}{m.missing && <span className="bi-off"><AlertTriangle size={12} />Offline</span>}{m.proxy && <span className="bi-proxy">Proxy</span>}</div>
            <div className="bi-meta">
              <span className="bi-kind">{m.kind === 'video' ? <Film size={11} /> : m.kind === 'audio' ? <Music size={11} /> : <ImageIcon size={11} />}</span>
              <span className="nm">{m.name}</span>
              {view === 'list' && <span className="dim small">{m.kind === 'audio' ? `${m.sampleRate ? (m.sampleRate / 1000).toFixed(1) + ' kHz' : ''}` : `${m.width}×${m.height}`}{m.fps && m.kind === 'video' ? ` · ${+m.fps.toFixed(2)} fps` : ''}</span>}
              {used.get(m.id) ? <span className="bi-used" title={`Used ${used.get(m.id)}× on the timeline`}>{used.get(m.id)}</span> : null}
            </div>
            {view === 'grid' && <div className="bi-sub dim">{m.kind === 'audio' ? (m.audioCodec ?? '').toUpperCase() : `${m.width}×${m.height}${m.kind === 'video' ? ` · ${(m.videoCodec ?? '').toUpperCase()}` : ''}`} · {fmtSize(m.size)}</div>}
            {m.missing && <button className="btn sm mt8" onClick={e => { e.stopPropagation(); relink(m); }}><LinkIcon size={12} />Relink</button>}
          </div>
        ))}
      </div>
      {over && <div className="drop-overlay">Drop to import</div>}
    </div>
  );
}
