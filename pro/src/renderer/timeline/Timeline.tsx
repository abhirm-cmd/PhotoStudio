/**
 * Multi-track timeline: ruler, track headers, clips with filmstrips and
 * waveforms, move/trim/razor/marquee, snapping, markers and media drops.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import { MousePointer2, Scissors, Magnet, Plus, Type, Square, Lock, Unlock, Eye, EyeOff, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2, Link2, ArrowLeftRight, Wand2 } from 'lucide-react';
import { type Project, type Clip, type Track, type MediaItem, clipEnd, timecode, projectDuration, newTrack } from '@shared/project';
import { moveClips, trimClip, splitClip, splitAt, snapFrame, clipsForMedia, placeClips, closeGap, withLinked } from '@shared/timeline';
import { isNeutral } from '@shared/grade';
import { useProject, P } from '../store/project';
import { usePlayer } from '../store/player';
import { cacheUrl } from '../api';
import { openMenu, promptText } from '../components/ui';
import * as A from '../services/actions';
import { MatchEditDialog, useMatchEdit } from '../components/MatchEdit';

export const MEDIA_DND = 'application/x-psp-media';
const HEAD_W = 168;
const RULER_H = 28;
const rowH = (t: Track) => (t.kind === 'video' ? 62 : 54);

type Tool = 'select' | 'razor';
interface TLState { tool: Tool; snap: boolean; ripple: boolean; zoom: number }
const saved: Partial<TLState> = (() => { try { return JSON.parse(localStorage.getItem('psp.timeline') ?? '{}'); } catch { return {}; } })();
export const tlPrefs: TLState = { tool: 'select', snap: true, ripple: false, zoom: 4, ...saved };
const listeners = new Set<() => void>();
export function setTl(patch: Partial<TLState>) {
  Object.assign(tlPrefs, patch);
  try { localStorage.setItem('psp.timeline', JSON.stringify({ snap: tlPrefs.snap, ripple: tlPrefs.ripple, zoom: tlPrefs.zoom })); } catch { /* ignore */ }
  listeners.forEach(l => l());
}
export function useTl() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force(n => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return tlPrefs;
}
export const zoomBy = (k: number) => setTl({ zoom: Math.min(60, Math.max(0.02, tlPrefs.zoom * k)) });

/* ------------------------------------------------------------- layout */

interface Row { track: Track; top: number; h: number }
function layoutRows(p: Project): { rows: Row[]; height: number; split: number } {
  const vt = p.tracks.filter(t => t.kind === 'video').reverse();
  const at = p.tracks.filter(t => t.kind === 'audio');
  const rows: Row[] = [];
  let y = 0;
  for (const t of vt) { rows.push({ track: t, top: y, h: rowH(t) }); y += rowH(t); }
  const split = y;
  y += 6;
  for (const t of at) { rows.push({ track: t, top: y, h: rowH(t) }); y += rowH(t); }
  return { rows, height: y, split };
}

/* -------------------------------------------------------------- clips */

const Waveform = memo(function Waveform({ m, clip, fps, zoom, x0, x1, h }: { m: MediaItem; clip: Clip; fps: number; zoom: number; x0: number; x1: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Uint8Array | null>(waveCache.get(m.waveform?.key ?? '') ?? null);
  useEffect(() => {
    if (!m.waveform) return;
    const k = m.waveform.key;
    if (waveCache.has(k)) { setPeaks(waveCache.get(k)!); return; }
    let live = true;
    fetch(cacheUrl(k)).then(r => r.arrayBuffer()).then(b => { const a = new Uint8Array(b); waveCache.set(k, a); if (live) setPeaks(a); }).catch(() => {});
    return () => { live = false; };
  }, [m.waveform?.key]);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !peaks || !m.waveform) return;
    const w = Math.max(1, Math.round(x1 - x0));
    const dpr = devicePixelRatio;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = 'rgba(160, 230, 190, 0.85)';
    const rate = m.waveform.rate;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const t0 = clip.srcIn + ((x0 + x) / zoom / fps) * clip.speed, t1 = clip.srcIn + ((x0 + x + 1) / zoom / fps) * clip.speed;
      let pk = 0;
      for (let i = Math.floor(t0 * rate); i <= Math.min(peaks.length - 1, Math.ceil(t1 * rate)); i++) if (peaks[i] > pk) pk = peaks[i];
      const a = (pk / 255) * mid * 0.95;
      g.fillRect(x, mid - a, 1, Math.max(1, a * 2));
    }
  }, [peaks, x0, x1, h, zoom, fps, clip.srcIn, clip.speed, m.waveform]);
  if (!m.waveform) return <div className="clip-pending">Building waveform…</div>;
  return <canvas ref={ref} className="clip-wave" style={{ left: x0, width: x1 - x0, height: h }} />;
});
const waveCache = new Map<string, Uint8Array>();

function Filmstrip({ m, clip, fps, zoom, x0, x1, h }: { m: MediaItem; clip: Clip; fps: number; zoom: number; x0: number; x1: number; h: number }) {
  const th = m.thumbs;
  if (!th) return <div className="clip-pending">Building filmstrip…</div>;
  const tw = (th.width * h) / th.height;
  const first = Math.floor(x0 / tw), last = Math.ceil(x1 / tw);
  const tiles = [];
  for (let i = first; i < last; i++) {
    const x = i * tw;
    const t = clip.srcIn + ((x + tw / 2) / zoom / fps) * clip.speed;
    const idx = th.count <= 1 ? 0 : Math.min(th.count - 1, Math.max(0, Math.floor(t / th.interval)));
    tiles.push(<div key={i} className="tile" style={{ left: x, width: tw, height: h, backgroundImage: `url("${cacheUrl(th.key)}")`, backgroundSize: `${th.count * tw}px ${h}px`, backgroundPosition: `${-idx * tw}px 0` }} />);
  }
  return <>{tiles}</>;
}

interface ClipProps { clip: Clip; media?: MediaItem; kind: 'video' | 'audio'; fps: number; zoom: number; top: number; h: number; selected: boolean; vx0: number; vx1: number; locked: boolean }

const ClipView = memo(function ClipView({ clip, media, kind, fps, zoom, top, h, selected, vx0, vx1, locked }: ClipProps) {
  const left = clip.start * zoom, width = Math.max(2, clip.duration * zoom);
  // Only draw the filmstrip/waveform where the clip is on screen
  const x0 = Math.max(0, vx0 - left), x1 = Math.min(width, vx1 - left);
  const bodyH = h - 20;
  const graded = clip.kind === 'media' && kind === 'video' && !isNeutral(clip.grade);
  const tr = clip.transitionIn;
  const cls = `clip ${kind} k-${clip.kind}${selected ? ' selected' : ''}${clip.enabled ? '' : ' disabled'}${media?.missing ? ' offline' : ''}${locked ? ' locked' : ''}`;
  return (
    <div className={cls} data-clip={clip.id} style={{ left, width, top, height: h - 4 }}>
      <div className="clip-label">
        {clip.linkId && <Link2 size={10} />}
        <span className="nm">{clip.kind === 'title' ? (clip.title?.text.split('\n')[0] || 'Title') : clip.name}</span>
        {clip.speed !== 1 && <span className="cb">{Math.round(clip.speed * 100)}%</span>}
        {graded && <span className="cb fx">Graded</span>}
        {media?.missing && <span className="cb off">Offline</span>}
      </div>
      <div className="clip-body" style={{ height: bodyH }}>
        {x1 > x0 && clip.kind === 'media' && media && kind === 'video' && <Filmstrip m={media} clip={clip} fps={fps} zoom={zoom} x0={x0} x1={x1} h={bodyH} />}
        {x1 > x0 && clip.kind === 'media' && media && kind === 'audio' && <Waveform m={media} clip={clip} fps={fps} zoom={zoom} x0={Math.floor(x0)} x1={Math.ceil(x1)} h={bodyH} />}
        {clip.kind === 'color' && <div className="clip-color" style={{ background: clip.color }} />}
        {clip.kind === 'title' && <div className="clip-title-txt">T</div>}
      </div>
      {kind === 'audio' && (clip.fadeIn > 0 || clip.fadeOut > 0) && (
        <svg className="clip-fades" width={width} height={h - 4} preserveAspectRatio="none">
          {clip.fadeIn > 0 && <path d={`M0 ${h - 4} L${clip.fadeIn * zoom} 2`} />}
          {clip.fadeOut > 0 && <path d={`M${width - clip.fadeOut * zoom} 2 L${width} ${h - 4}`} />}
        </svg>
      )}
      {kind === 'video' && clip.fadeIn > 0 && <div className="vfade in" style={{ width: clip.fadeIn * zoom }} />}
      {kind === 'video' && clip.fadeOut > 0 && <div className="vfade out" style={{ width: clip.fadeOut * zoom }} />}
      {tr && <div className={`clip-tr ${tr.type}`} data-tr={clip.id} style={{ width: Math.min(width, tr.duration * zoom) }} title={`${tr.type[0].toUpperCase() + tr.type.slice(1)} · ${tr.duration} frames`}><span>{tr.type === 'dissolve' ? 'Cross dissolve' : tr.type === 'dip' ? 'Dip to black' : 'Slide'}</span></div>}
      <div className="fade-handle in" data-fade="in" style={{ left: Math.max(0, clip.fadeIn * zoom) - 5 }} title="Drag to fade in" />
      <div className="fade-handle out" data-fade="out" style={{ left: width - clip.fadeOut * zoom - 5 }} title="Drag to fade out" />
      <div className="trim in" data-trim="in" />
      <div className="trim out" data-trim="out" />
    </div>
  );
});

/* ----------------------------------------------------------- playhead */

function Playhead({ zoom, height, scroller }: { zoom: number; height: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const frame = usePlayer(s => s.frame);
  const playing = usePlayer(s => s.playing);
  const x = frame * zoom;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const view = el.clientWidth - HEAD_W;
    if (x > el.scrollLeft + view - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
  }, [x, playing, scroller]);
  return <div className="playhead" style={{ transform: `translateX(${x + HEAD_W}px)`, height }}><div className="ph-head" /></div>;
}

/* ------------------------------------------------------------- ruler */

function Ruler({ p, zoom, width, onScrub }: { p: Project; zoom: number; width: number; onScrub(e: React.PointerEvent): void }) {
  const fps = p.settings.fps;
  // Pick a major tick interval that leaves ~90px between labels
  const steps = [1, 2, 5, 10, 15, fps, fps * 2, fps * 5, fps * 10, fps * 15, fps * 30, fps * 60, fps * 120, fps * 300, fps * 600];
  const major = steps.find(s => s * zoom >= 90) ?? steps[steps.length - 1];
  const minor = major / (major >= fps ? 5 : major >= 5 ? 5 : 1);
  const ticks = [];
  const n = Math.ceil(width / zoom);
  for (let f = 0; f <= n; f += major) ticks.push(<div key={f} className="tick major" style={{ left: f * zoom }}><span>{timecode(f, fps)}</span></div>);
  if (minor * zoom >= 8) for (let f = 0; f <= n; f += minor) if (f % major) ticks.push(<div key={`m${f}`} className="tick" style={{ left: f * zoom }} />);
  return (
    <div className="ruler" style={{ width }} onPointerDown={onScrub}>
      {p.inPoint != null || p.outPoint != null ? <div className="io-range" style={{ left: (p.inPoint ?? 0) * zoom, width: ((p.outPoint ?? projectDuration(p)) - (p.inPoint ?? 0)) * zoom }} /> : null}
      {ticks}
      {p.markers.map(m => (
        <div key={m.id} className="marker" style={{ left: m.frame * zoom, color: m.color }} title={m.name}
          onPointerDown={e => { e.stopPropagation(); usePlayer.getState().pause(); usePlayer.getState().setFrame(m.frame); }}
          onDoubleClick={async () => { const n = await promptText('Rename marker', m.name); if (n) useProject.getState().edit('Rename marker', q => { q.markers.find(x => x.id === m.id)!.name = n; }); }}
          onContextMenu={e => openMenu(e, [{ label: 'Rename…', onClick: async () => { const n = await promptText('Rename marker', m.name); if (n) useProject.getState().edit('Rename marker', q => { q.markers.find(x => x.id === m.id)!.name = n; }); } }, { label: 'Delete marker', danger: true, onClick: () => useProject.getState().edit('Delete marker', q => { q.markers = q.markers.filter(x => x.id !== m.id); }) }])}>
          <svg width="11" height="12" viewBox="0 0 11 12"><path d="M0 0h11v7l-5.5 5L0 7z" fill="currentColor" /></svg>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ headers */

function TrackHead({ t, h, top }: { t: Track; h: number; top: number }) {
  const edit = useProject(s => s.edit);
  const set = (label: string, patch: Partial<Track>) => edit(label, p => Object.assign(p.tracks.find(x => x.id === t.id)!, patch));
  const menu = (e: React.MouseEvent) => openMenu(e, [
    { label: 'Rename track…', onClick: async () => { const n = await promptText('Rename track', t.name); if (n) set('Rename track', { name: n }); } },
    { label: `Add ${t.kind} track`, onClick: () => edit('Add track', p => { const n = p.tracks.filter(x => x.kind === t.kind).length + 1; const nt = newTrack(t.kind, n); const i = p.tracks.findIndex(x => x.id === t.id); p.tracks.splice(t.kind === 'video' ? i + 1 : i + 1, 0, nt); }) },
    { sep: true },
    { label: 'Delete track', danger: true, disabled: P().clips.some(c => c.trackId === t.id) || P().tracks.filter(x => x.kind === t.kind).length <= 1, onClick: () => edit('Delete track', p => { p.tracks = p.tracks.filter(x => x.id !== t.id); }) },
  ]);
  return (
    <div className={`track-head ${t.kind}`} style={{ top, height: h }} onContextMenu={menu}>
      <div className="th-name" onDoubleClick={async () => { const n = await promptText('Rename track', t.name); if (n) set('Rename track', { name: n }); }}>{t.name}</div>
      <div className="th-btns">
        <button className={`icon-btn sm${t.locked ? ' active' : ''}`} title={t.locked ? 'Unlock track' : 'Lock track'} aria-pressed={t.locked} onClick={() => set(t.locked ? 'Unlock track' : 'Lock track', { locked: !t.locked })}>{t.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
        {t.kind === 'video'
          ? <button className={`icon-btn sm${t.hidden ? ' active' : ''}`} title={t.hidden ? 'Show track' : 'Hide track output'} aria-pressed={t.hidden} onClick={() => set(t.hidden ? 'Show track' : 'Hide track', { hidden: !t.hidden })}>{t.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
          : <>
            <button className={`icon-btn sm txt${t.muted ? ' active mute' : ''}`} title="Mute" aria-pressed={t.muted} onClick={() => set(t.muted ? 'Unmute' : 'Mute', { muted: !t.muted })}>M</button>
            <button className={`icon-btn sm txt${t.solo ? ' active solo' : ''}`} title="Solo" aria-pressed={t.solo} onClick={() => set(t.solo ? 'Unsolo' : 'Solo', { solo: !t.solo })}>S</button>
          </>}
      </div>
      {t.kind === 'audio' && <div className="th-vol" title="Track volume (Audio page has the full mixer)">{t.volume > 0 ? '+' : ''}{t.volume.toFixed(1)} dB</div>}
    </div>
  );
}

/* ----------------------------------------------------------- timeline */

type Drag =
  | { kind: 'move'; base: Project; ids: string[]; startX: number; startY: number; startFrame: number; origRow: number; linked: boolean; key: string; moved: boolean }
  | { kind: 'trim'; base: Project; id: string; edge: 'in' | 'out'; key: string; ripple: boolean }
  | { kind: 'fade'; base: Project; id: string; edge: 'in' | 'out'; key: string }
  | { kind: 'tr'; base: Project; id: string; key: string }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'scrub' };

export function Timeline() {
  const p = useProject(s => s.project);
  const selection = useProject(s => s.selection);
  const tl = useTl();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x0: 0, x1: 2000 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ x: number; top: number; h: number } | null>(null);
  const fps = p.settings.fps;
  const zoom = tl.zoom;
  const { rows, height } = useMemo(() => layoutRows(p), [p]);
  const dur = projectDuration(p);
  const width = Math.max((dur + fps * 30) * zoom, (view.x1 - view.x0) + 400);
  const sel = useMemo(() => new Set(selection), [selection]);

  // Track the visible range (coarsely, so scrolling doesn't re-render every pixel)
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const x0 = Math.floor(el.scrollLeft / 400) * 400, x1 = Math.ceil((el.scrollLeft + el.clientWidth) / 400) * 400 + 400;
    setView(v => (v.x0 === x0 && v.x1 === x1 ? v : { x0, x1 }));
  }, []);
  useEffect(() => { onScroll(); const ro = new ResizeObserver(onScroll); if (scroller.current) ro.observe(scroller.current); return () => ro.disconnect(); }, [onScroll]);

  // Ctrl/Cmd + wheel zooms around the pointer
  useEffect(() => {
    const el = scroller.current!;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) && !e.altKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - HEAD_W + el.scrollLeft;
      const f = px / tlPrefs.zoom;
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      el.scrollLeft = Math.max(0, f * tlPrefs.zoom - (e.clientX - r.left - HEAD_W));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const pos = (e: { clientX: number; clientY: number }) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left - HEAD_W + el.scrollLeft, y: e.clientY - r.top - RULER_H + el.scrollTop };
  };
  const rowAt = (y: number) => rows.findIndex(r => y >= r.top && y < r.top + r.h);
  const snapTo = (f: number, exclude: Set<string>, on: boolean) => {
    if (!on) return { frame: f, snapped: false };
    const r = snapFrame(P(), f, Math.max(1, Math.round(8 / zoom)), exclude, [usePlayer.getState().frame, ...(P().inPoint != null ? [P().inPoint!] : []), ...(P().outPoint != null ? [P().outPoint!] : [])]);
    return r;
  };

  const scrubTo = (e: { clientX: number; clientY: number }) => {
    const { x } = pos(e);
    let f = Math.max(0, Math.round(x / zoom));
    if (tlPrefs.snap) { const s = snapTo(f, new Set(), true); f = s.frame; }
    usePlayer.getState().setFrame(f);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    const { x, y } = pos(e);
    if (y < 0) return;
    const store = useProject.getState();
    if (!clipEl) {
      if (!e.shiftKey) store.select([]);
      setDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const id = clipEl.dataset.clip!;
    const clip = store.project.clips.find(c => c.id === id)!;
    const track = store.project.tracks.find(t => t.id === clip.trackId)!;
    const now = Date.now();
    if (tlPrefs.tool === 'razor') {
      let f = Math.round(x / zoom);
      if (Math.abs(f - usePlayer.getState().frame) * zoom < 6) f = usePlayer.getState().frame;
      if (track.locked) return;
      store.edit('Razor', q => { if (e.shiftKey) splitAt(q, f); else splitClip(q, id, f, !e.altKey); });
      return;
    }
    // Selection: click selects the clip (and its linked partner unless Alt)
    const ids = e.altKey ? [id] : withLinked(store.project, [id]);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (sel.has(id)) store.select(selection.filter(s => !ids.includes(s)));
      else store.select(ids, true);
    } else if (!sel.has(id)) store.select(ids);
    if (track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const trim = target.dataset.trim as 'in' | 'out' | undefined;
    const fade = target.dataset.fade as 'in' | 'out' | undefined;
    if (target.closest('[data-tr]') && clip.transitionIn && !trim) { setDrag({ kind: 'tr', base: store.project, id, key: `tr:${now}` }); return; }
    if (trim) { setDrag({ kind: 'trim', base: store.project, id, edge: trim, key: `trim:${now}`, ripple: tlPrefs.ripple !== (e.ctrlKey || e.metaKey) }); return; }
    if (fade) { setDrag({ kind: 'fade', base: store.project, id, edge: fade, key: `fade:${now}` }); return; }
    const moveIds = e.shiftKey || e.metaKey || e.ctrlKey ? [...new Set([...selection, ...ids])] : sel.has(id) ? selection : ids;
    setDrag({ kind: 'move', base: store.project, ids: moveIds, startX: x, startY: y, startFrame: clip.start, origRow: rowAt(y), linked: !e.altKey, key: `move:${now}`, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const { x, y } = pos(e);
    const store = useProject.getState();
    if (drag.kind === 'scrub') { scrubTo(e); return; }
    if (drag.kind === 'marquee') { setDrag({ ...drag, x1: x, y1: y }); return; }
    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 4) return;
      const base = drag.base;
      const all = drag.linked ? withLinked(base, drag.ids) : drag.ids;
      const moving = base.clips.filter(c => all.includes(c.id));
      let df = Math.round((x - drag.startX) / zoom);
      // Snap whichever edge of the moving block is closest to a target
      const minS = Math.min(...moving.map(c => c.start)), maxE = Math.max(...moving.map(clipEnd));
      const ex = new Set(all);
      const a = snapTo(minS + df, ex, tlPrefs.snap), b = snapTo(maxE + df, ex, tlPrefs.snap);
      let line: number | null = null;
      if (a.snapped && (!b.snapped || Math.abs(a.frame - (minS + df)) <= Math.abs(b.frame - (maxE + df)))) { df = a.frame - minS; line = a.frame; }
      else if (b.snapped) { df = b.frame - maxE; line = b.frame; }
      setSnapLine(line);
      // Track change: count rows of the dragged clip's kind between start and pointer
      const r0 = rows[drag.origRow], r1 = rows[rowAt(y)];
      let td = { video: 0, audio: 0 };
      if (r0 && r1 && r0.track.kind === r1.track.kind) {
        const kind = r0.track.kind;
        const list = base.tracks.filter(t => t.kind === kind);
        td = { ...td, [kind]: list.findIndex(t => t.id === r1.track.id) - list.findIndex(t => t.id === r0.track.id) };
      }
      store.editFrom(base, 'Move', q => moveClips(q, drag.ids, df, td, drag.linked), drag.key);
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }
    if (drag.kind === 'trim') {
      const c = drag.base.clips.find(q => q.id === drag.id)!;
      let f = Math.max(0, Math.round(x / zoom));
      const s = snapTo(f, new Set(withLinked(drag.base, [drag.id])), tlPrefs.snap);
      f = s.frame;
      setSnapLine(s.snapped ? f : null);
      store.editFrom(drag.base, drag.ripple ? 'Ripple trim' : 'Trim', q => trimClip(q, c.id, drag.edge, f, drag.ripple), drag.key);
      return;
    }
    if (drag.kind === 'fade') {
      const c = drag.base.clips.find(q => q.id === drag.id)!;
      const f = Math.round(x / zoom);
      const len = drag.edge === 'in' ? f - c.start : clipEnd(c) - f;
      const v = Math.max(0, Math.min(c.duration, len));
      store.editFrom(drag.base, drag.edge === 'in' ? 'Fade in' : 'Fade out', q => {
        for (const id of [drag.id]) { const x2 = q.clips.find(k => k.id === id)!; if (drag.edge === 'in') x2.fadeIn = v; else x2.fadeOut = v; }
      }, drag.key);
      return;
    }
    if (drag.kind === 'tr') {
      const c = drag.base.clips.find(q => q.id === drag.id)!;
      const d = Math.max(2, Math.min(c.duration, Math.round(x / zoom) - c.start));
      store.editFrom(drag.base, 'Transition length', q => { const x2 = q.clips.find(k => k.id === drag.id)!; if (x2.transitionIn) x2.transitionIn.duration = d; }, drag.key);
    }
  };

  const onPointerUp = () => {
    if (drag?.kind === 'marquee') {
      const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
      const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
      if (x1 - x0 < 3 && y1 - y0 < 3) {
        // A plain click on empty space moves the playhead there
        if (!drag.add) usePlayer.getState().setFrame(Math.max(0, Math.round(x0 / zoom)));
      } else {
        const hit = P().clips.filter(c => {
          const r = rows.find(rr => rr.track.id === c.trackId);
          return r && c.start * zoom < x1 && clipEnd(c) * zoom > x0 && r.top < y1 && r.top + r.h > y0;
        }).map(c => c.id);
        useProject.getState().select(hit, drag.add);
      }
    }
    setDrag(null);
    setSnapLine(null);
  };

  const onRulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    usePlayer.getState().pause();
    scrubTo(e);
    (scroller.current as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: 'scrub' });
  };

  /* --- media drops from the bin or source monitor */
  const dropTarget = (e: React.DragEvent) => {
    const { x, y } = pos(e);
    const r = rows[rowAt(y)];
    let f = Math.max(0, Math.round(x / zoom));
    const s = snapTo(f, new Set(), tlPrefs.snap);
    f = s.frame;
    return { f, row: r };
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(MEDIA_DND)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { f, row } = dropTarget(e);
    if (row) setDropHint({ x: f * zoom, top: row.top, h: row.h }); else setDropHint(null);
  };
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(MEDIA_DND);
    setDropHint(null);
    if (!raw) return;
    e.preventDefault();
    const { mediaId, srcIn, srcOut } = JSON.parse(raw) as { mediaId: string; srcIn?: number; srcOut?: number };
    const { f, row } = dropTarget(e);
    const p0 = P();
    const vts = p0.tracks.filter(t => t.kind === 'video'), ats = p0.tracks.filter(t => t.kind === 'audio');
    let videoTrack = vts[0]?.id, audioTrack = ats[0]?.id;
    if (row?.track.kind === 'video') { videoTrack = row.track.id; audioTrack = ats[Math.min(ats.length - 1, vts.findIndex(t => t.id === row.track.id))]?.id; }
    if (row?.track.kind === 'audio') { audioTrack = row.track.id; videoTrack = vts[Math.min(vts.length - 1, ats.findIndex(t => t.id === row.track.id))]?.id; }
    if ([videoTrack, audioTrack].some(t => t && p0.tracks.find(x => x.id === t)?.locked)) return;
    let ids: string[] = [];
    useProject.getState().edit(e.ctrlKey || e.metaKey ? 'Insert' : 'Overwrite', q => {
      const cs = clipsForMedia(q, mediaId, f, { videoTrack, audioTrack, srcIn, srcOut });
      ids = cs.map(c => c.id);
      placeClips(q, cs, e.ctrlKey || e.metaKey ? 'insert' : 'overwrite');
    });
    useProject.getState().select(ids);
  };

  const onContext = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    const { x, y } = pos(e);
    const f = Math.max(0, Math.round(x / zoom));
    if (!clipEl) {
      const r = rows[rowAt(y)];
      if (!r) return;
      openMenu(e, [
        { label: 'Close gap', disabled: !closeGap(structuredClone(P()), r.track.id, f), onClick: () => useProject.getState().edit('Close gap', q => { closeGap(q, r.track.id, f); }) },
        { label: 'Paste', shortcut: 'Mod+V', onClick: () => { usePlayer.getState().setFrame(f); A.paste(); } },
        { label: 'Add marker here', onClick: () => { usePlayer.getState().setFrame(f); A.addMarker(); } },
      ]);
      return;
    }
    const id = clipEl.dataset.clip!;
    const store = useProject.getState();
    if (!store.selection.includes(id)) store.select(withLinked(store.project, [id]));
    const c = store.project.clips.find(q => q.id === id)!;
    const isVideo = store.project.tracks.find(t => t.id === c.trackId)?.kind === 'video';
    openMenu(e, [
      { label: 'Split here', shortcut: 'C', onClick: () => store.edit('Split', q => splitClip(q, id, f, true)) },
      { label: c.enabled ? 'Disable' : 'Enable', shortcut: 'Shift+E', onClick: A.toggleEnabled },
      { label: c.linkId ? 'Unlink audio/video' : 'Link selected', onClick: A.linkSelection },
      ...(isVideo ? [
        { sep: true },
        { label: 'Cross dissolve in', onClick: () => A.setTransition('dissolve', [id]) },
        { label: 'Dip to black in', onClick: () => A.setTransition('dip', [id]) },
        { label: 'Slide in', onClick: () => A.setTransition('slide', [id]) },
        ...(c.transitionIn ? [{ label: 'Remove transition', onClick: () => A.setTransition(null, [id]) }] : []),
      ] : []),
      { sep: true },
      { label: 'Copy', shortcut: 'Mod+C', onClick: A.copySelection },
      { label: 'Rename…', onClick: async () => { const n = await promptText('Rename clip', c.name); if (n) store.edit('Rename clip', q => { q.clips.find(k => k.id === id)!.name = n; }); } },
      { label: 'Delete', shortcut: 'Del', danger: true, onClick: () => A.deleteSelection(false) },
      { label: 'Ripple delete', shortcut: 'Shift+Del', danger: true, onClick: () => A.deleteSelection(true) },
    ]);
  };

  const zoomFit = () => {
    const el = scroller.current;
    if (!el) return;
    setTl({ zoom: Math.max(0.02, (el.clientWidth - HEAD_W - 40) / Math.max(fps * 5, dur)) });
    el.scrollLeft = 0;
  };

  const trackOfClip = new Map(p.tracks.map(t => [t.id, t]));
  const rowOf = new Map(rows.map(r => [r.track.id, r]));
  const mediaById = new Map(p.media.map(m => [m.id, m]));
  const marquee = drag?.kind === 'marquee' ? drag : null;

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="seg">
          <button className={tl.tool === 'select' ? 'on' : ''} onClick={() => setTl({ tool: 'select' })} title="Selection tool (V)"><MousePointer2 size={13} /></button>
          <button className={tl.tool === 'razor' ? 'on' : ''} onClick={() => setTl({ tool: 'razor' })} title="Razor tool (C) — Shift splits every track"><Scissors size={13} /></button>
        </div>
        <button className={`icon-btn${tl.snap ? ' active' : ''}`} aria-pressed={tl.snap} onClick={() => setTl({ snap: !tl.snap })} title="Snapping (S)"><Magnet size={14} /></button>
        <button className={`icon-btn${tl.ripple ? ' active' : ''}`} aria-pressed={tl.ripple} onClick={() => setTl({ ripple: !tl.ripple })} title="Ripple trims (hold Ctrl/⌘ to flip while trimming)"><ArrowLeftRight size={14} /></button>
        <span className="tl-sep" />
        <button className="btn sm ghost" onClick={() => A.addTitle()} title="Add a title at the playhead"><Type size={13} />Title</button>
        <button className="btn sm ghost" onClick={() => A.addColor()} title="Add a color matte at the playhead"><Square size={13} />Matte</button>
        <button className="btn sm ghost" onClick={() => useProject.getState().edit('Add tracks', q => { const nv = q.tracks.filter(t => t.kind === 'video').length + 1; const na = q.tracks.filter(t => t.kind === 'audio').length + 1; const vi = q.tracks.map(t => t.kind).lastIndexOf('video'); q.tracks.splice(vi + 1, 0, newTrack('video', nv)); q.tracks.push(newTrack('audio', na)); })} title="Add a video and an audio track"><Plus size={13} />Tracks</button>
        <button className="btn sm ghost" onClick={() => useMatchEdit.getState().setOpen(true)} title="Copy the cuts, transitions and moves of an edited video onto new footage" data-testid="match-open"><Wand2 size={13} />Match Edit</button>
        <MatchEditDialog />
        <span className="grow" />
        <span className="tl-hint">{tl.tool === 'razor' ? 'Click a clip to cut it' : 'Drag media here · Ctrl/⌘ while dropping inserts'}</span>
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.5)} title="Zoom out (-)"><ZoomOut size={14} /></button>
        <input className="tl-zoom" type="range" min={-4} max={4.1} step={0.01} value={Math.log(zoom) / Math.LN2 / 1.5} onChange={e => setTl({ zoom: Math.pow(2, Number(e.target.value) * 1.5) })} aria-label="Timeline zoom" />
        <button className="icon-btn" onClick={() => zoomBy(1.5)} title="Zoom in (=)"><ZoomIn size={14} /></button>
        <button className="icon-btn" onClick={zoomFit} title="Zoom to fit (\\)"><Maximize2 size={14} /></button>
      </div>
      <div className={`tl-scroll tool-${tl.tool}`} ref={scroller} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDragOver={onDragOver} onDragLeave={() => setDropHint(null)} onDrop={onDrop} onContextMenu={onContext} data-testid="timeline">
        <div className="tl-content" style={{ width: width + HEAD_W, height: height + RULER_H + 40 }}>
          <div className="tl-ruler-row">
            <div className="tl-corner"><TimecodeReadout fps={fps} /></div>
            <Ruler p={p} zoom={zoom} width={width} onScrub={onRulerDown} />
          </div>
          <div className="tl-heads">{rows.map(r => <TrackHead key={r.track.id} t={r.track} h={r.h} top={r.top} />)}</div>
          <div className="tl-lanes" style={{ left: HEAD_W, top: RULER_H, width, height }}>
            {rows.map(r => <div key={r.track.id} className={`lane ${r.track.kind}${r.track.locked ? ' locked' : ''}`} style={{ top: r.top, height: r.h }} />)}
            {p.clips.map(c => {
              const r = rowOf.get(c.trackId);
              if (!r) return null;
              if (c.start * zoom > view.x1 || clipEnd(c) * zoom < view.x0 - 50) return null;
              const t = trackOfClip.get(c.trackId)!;
              return <ClipView key={c.id} clip={c} media={c.mediaId ? mediaById.get(c.mediaId) : undefined} kind={t.kind} fps={fps} zoom={zoom} top={r.top + 2} h={r.h} selected={sel.has(c.id)} vx0={view.x0 - 200} vx1={view.x1 + 200} locked={t.locked} />;
            })}
            {snapLine != null && <div className="snap-line" style={{ left: snapLine * zoom, height }} />}
            {dropHint && <div className="drop-hint" style={{ left: dropHint.x, top: dropHint.top, height: dropHint.h }} />}
            {marquee && <div className="marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
            {!p.clips.length && <div className="tl-empty"><b>Your timeline is empty.</b> Drag clips here from the media bin, or open one in the source monitor and press <span className="kbd">,</span> to insert or <span className="kbd">.</span> to overwrite.</div>}
          </div>
          <Playhead zoom={zoom} height={height + RULER_H} scroller={scroller} />
        </div>
      </div>
    </div>
  );
}

function TimecodeReadout({ fps }: { fps: number }) {
  const frame = usePlayer(s => s.frame);
  return <span className="tc" data-testid="timeline-tc">{timecode(frame, fps)}</span>;
}

