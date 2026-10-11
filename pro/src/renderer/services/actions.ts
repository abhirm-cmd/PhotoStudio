/** Editing commands shared by keyboard shortcuts, menus and toolbar buttons. */
import { newClip, defaultTitle, uid, clipEnd, projectDuration, type Clip, type TransitionType, type Project } from '@shared/project';
import { clipsForMedia, placeClips, splitAt, splitClip, deleteClips, withLinked, moveClips, clearRange, type EditMode } from '@shared/timeline';
import { useProject, P, selectedClips } from '../store/project';
import { usePlayer } from '../store/player';
import { toast } from '../store/ui';

const edit = (label: string, fn: (p: Project) => void, key?: string) => useProject.getState().edit(label, fn, key);
const frame = () => usePlayer.getState().frame;

export function splitAtPlayhead(allTracks = false) {
  const f = frame(), p0 = P();
  const locked = new Set(p0.tracks.filter(t => t.locked).map(t => t.id));
  const under = (c: Clip) => f > c.start && f < clipEnd(c) && !locked.has(c.trackId);
  const sel = selectedClips().filter(under);
  const useSel = sel.length > 0 && !allTracks;
  if (!useSel && !p0.clips.some(under)) { toast({ kind: 'info', title: 'Nothing to split at the playhead' }); return; }
  edit('Split', p => {
    if (useSel) { for (const c of sel) if (p.clips.some(x => x.id === c.id && under(x))) splitClip(p, c.id, f, true); }
    else splitAt(p, f);
  });
}

export function deleteSelection(ripple = false) {
  const ids = useProject.getState().selection;
  if (!ids.length) return;
  edit(ripple ? 'Ripple delete' : 'Delete', p => deleteClips(p, ids, ripple));
  useProject.getState().select([]);
}

export function toggleEnabled() {
  const ids = withLinked(P(), useProject.getState().selection);
  if (!ids.length) return;
  const on = !selectedClips().every(c => c.enabled);
  edit(on ? 'Enable clips' : 'Disable clips', p => { for (const c of p.clips) if (ids.includes(c.id)) c.enabled = on; });
}

export function linkSelection() {
  const sel = selectedClips();
  if (!sel.length) return;
  const linked = sel.some(c => c.linkId);
  edit(linked ? 'Unlink' : 'Link', p => {
    if (linked) { const links = new Set(sel.map(c => c.linkId)); for (const c of p.clips) if (links.has(c.linkId)) c.linkId = null; }
    else { const id = uid('l'); for (const c of p.clips) if (sel.some(s => s.id === c.id)) c.linkId = id; }
  });
}

export function setTransition(type: TransitionType | null, ids = useProject.getState().selection) {
  const p0 = P();
  const targets = p0.clips.filter(c => ids.includes(c.id) && p0.tracks.find(t => t.id === c.trackId)?.kind === 'video');
  if (!targets.length) { toast({ kind: 'info', title: 'Select a video clip first' }); return; }
  edit(type ? `Add ${type}` : 'Remove transition', p => {
    for (const c of p.clips) if (targets.some(t => t.id === c.id)) c.transitionIn = type ? { type, duration: c.transitionIn?.duration ?? Math.round(p.settings.fps) } : null;
  });
}

export function addMarker() {
  const f = frame();
  edit('Add marker', p => { if (!p.markers.some(m => m.frame === f)) p.markers.push({ id: uid('mk'), frame: f, name: `Marker ${p.markers.length + 1}`, color: '#e3a95c' }); });
}

export function setInOut(which: 'in' | 'out' | 'clear') {
  const f = frame();
  edit(which === 'clear' ? 'Clear in/out' : `Mark ${which}`, p => {
    if (which === 'clear') { p.inPoint = null; p.outPoint = null; return; }
    if (which === 'in') { p.inPoint = f; if (p.outPoint != null && p.outPoint <= f) p.outPoint = null; }
    else { p.outPoint = f + 1; if (p.inPoint != null && p.inPoint > f) p.inPoint = null; }
  });
}

/** Free video track for a new generated clip at [start, end), creating one above if needed. */
function freeVideoTrack(p: Project, start: number, end: number) {
  const vts = p.tracks.filter(t => t.kind === 'video' && !t.locked);
  for (const t of vts.slice(1).concat(vts.slice(0, 1))) if (!p.clips.some(c => c.trackId === t.id && c.start < end && clipEnd(c) > start)) return t.id;
  return vts[vts.length - 1].id;
}

export function addTitle(text = 'Title') {
  const p0 = P(), f = frame(), len = Math.round(p0.settings.fps * 5);
  let id = '';
  edit('Add title', p => {
    const c = newClip({ trackId: freeVideoTrack(p, f, f + len), kind: 'title', name: text, start: f, duration: len, title: { ...defaultTitle(), text } });
    id = c.id;
    placeClips(p, [c]);
  });
  useProject.getState().select([id]);
}

export function addColor(color = '#1d2b4a') {
  const p0 = P(), f = frame(), len = Math.round(p0.settings.fps * 5);
  let id = '';
  edit('Add color matte', p => {
    const c = newClip({ trackId: freeVideoTrack(p, f, f + len), kind: 'color', name: 'Color matte', start: f, duration: len, color });
    id = c.id;
    placeClips(p, [c]);
  });
  useProject.getState().select([id]);
}

/** Put the source monitor's media (between its in/out marks) on the timeline at the playhead. */
export function editFromSource(mode: EditMode) {
  const pl = usePlayer.getState();
  const p0 = P();
  const m = p0.media.find(x => x.id === pl.sourceId);
  if (!m) { toast({ kind: 'info', title: 'Open a clip in the source monitor first' }); return; }
  if (m.missing) { toast({ kind: 'error', title: `${m.name} is offline` }); return; }
  const srcIn = pl.sourceIn ?? 0, srcOut = pl.sourceOut ?? (m.kind === 'image' ? undefined : m.duration);
  let ids: string[] = [];
  edit(mode === 'insert' ? 'Insert' : 'Overwrite', p => {
    const cs = clipsForMedia(p, m.id, frame(), { srcIn, srcOut });
    ids = cs.map(c => c.id);
    placeClips(p, cs, mode);
  });
  const placed = P().clips.find(c => c.id === ids[0]);
  useProject.getState().select(ids);
  if (placed) usePlayer.getState().setFrame(clipEnd(placed));
}

/** Append media to the end of the timeline (double-click in the bin with Shift, or "Append"). */
export function appendMedia(mediaId: string) {
  const end = projectDuration(P());
  edit('Append', p => placeClips(p, clipsForMedia(p, mediaId, end)));
}

let clipboard: Clip[] = [];
export function copySelection() {
  const p = P();
  const ids = withLinked(p, useProject.getState().selection);
  clipboard = structuredClone(p.clips.filter(c => ids.includes(c.id)));
  if (clipboard.length) toast({ kind: 'info', title: `Copied ${clipboard.length} clip${clipboard.length > 1 ? 's' : ''}` }, 1800);
}

export function paste() {
  if (!clipboard.length) return;
  const f = frame();
  const min = Math.min(...clipboard.map(c => c.start));
  const linkMap = new Map<string, string>();
  const fresh = clipboard.map(c => ({ ...structuredClone(c), id: uid('c'), start: c.start - min + f, linkId: c.linkId ? (linkMap.get(c.linkId) ?? linkMap.set(c.linkId, uid('l')).get(c.linkId)!) : null }));
  edit('Paste', p => { const valid = fresh.filter(c => p.tracks.some(t => t.id === c.trackId)); placeClips(p, valid); });
  useProject.getState().select(fresh.map(c => c.id));
}

export function nudge(frames: number) {
  const ids = useProject.getState().selection;
  if (!ids.length) return false;
  edit('Nudge', p => moveClips(p, ids, frames), `nudge:${ids.join()}`);
  return true;
}

/** Jump to the previous/next cut on any track. */
export function jumpEdit(dir: 1 | -1) {
  const p = P(), f = frame();
  const pts = [...new Set([0, ...p.clips.flatMap(c => [c.start, clipEnd(c)])])].sort((a, b) => a - b);
  const t = dir > 0 ? pts.find(x => x > f) : [...pts].reverse().find(x => x < f);
  if (t != null) usePlayer.getState().setFrame(t);
}

export function selectAll() { useProject.getState().select(P().clips.map(c => c.id)); }

export function togglePlay() {
  const pl = usePlayer.getState();
  if (pl.playing) pl.pause();
  else {
    const p = P(), end = projectDuration(p);
    if (pl.frame >= end - 1) pl.setFrame(pl.loop && p.inPoint != null ? p.inPoint : 0);
    pl.play(1);
  }
}

/** J/K/L shuttle */
export function shuttle(dir: -1 | 0 | 1) {
  const pl = usePlayer.getState();
  if (dir === 0) { pl.pause(); return; }
  const cur = pl.playing ? pl.rate : 0;
  const next = Math.sign(cur) === dir ? Math.max(-8, Math.min(8, cur * 2)) : dir;
  pl.play(next);
}

export function step(frames: number) {
  const pl = usePlayer.getState();
  pl.pause();
  pl.setFrame(Math.max(0, pl.frame + frames));
}

/** Change playback speed; the clip's length follows so the same source range plays. */
export function setSpeed(ids: string[], speed: number, key?: string) {
  const s = Math.min(16, Math.max(0.1, speed));
  const all = withLinked(P(), ids);
  edit('Speed', p => {
    const fps = p.settings.fps;
    for (const id of all) {
      const c = p.clips.find(x => x.id === id);
      if (!c || c.kind !== 'media') continue;
      const src = (c.duration / fps) * c.speed;
      const oldEnd = clipEnd(c);
      c.speed = s;
      const m = p.media.find(x => x.id === c.mediaId);
      let d = Math.max(1, Math.round((src / s) * fps));
      if (m && m.kind !== 'image') d = Math.min(d, Math.floor(((m.duration - c.srcIn) / s) * fps + 1e-6));
      c.duration = d;
      if (clipEnd(c) > oldEnd) clearRange(p, c.trackId, oldEnd, clipEnd(c), new Set(all));
    }
  }, key);
}
