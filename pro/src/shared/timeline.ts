/**
 * Timeline editing operations and render resolution, shared by the editor UI,
 * the preview player and the FFmpeg export. Operations mutate the project they
 * receive; callers clone first (the store keeps immutable history snapshots).
 */
import { type Project, type Clip, type Track, newClip, uid, clipEnd, mediaOf, clipsOnTrack, trackAudible } from './project';

/* ------------------------------------------------------------- helpers */

export function withLinked(p: Project, ids: string[]): string[] {
  const set = new Set(ids);
  const links = new Set(p.clips.filter(c => set.has(c.id) && c.linkId).map(c => c.linkId));
  for (const c of p.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id);
  return [...set];
}

/** Longest a clip may run from its source in-point (Infinity for images, titles, colors). */
export function maxDurationFrames(p: Project, c: Clip): number {
  const m = mediaOf(p, c.mediaId);
  if (!m || m.kind === 'image' || c.kind !== 'media') return Infinity;
  return Math.floor(((m.duration - c.srcIn) / c.speed) * p.settings.fps + 1e-6);
}

/** Earliest start for a head trim (how far the in-point can move left). */
export function minStartFrames(p: Project, c: Clip): number {
  const m = mediaOf(p, c.mediaId);
  if (!m || m.kind === 'image' || c.kind !== 'media') return 0;
  return Math.max(0, c.start - Math.floor((c.srcIn / c.speed) * p.settings.fps + 1e-6));
}

const remove = (p: Project, id: string) => { p.clips = p.clips.filter(c => c.id !== id); };

/* ---------------------------------------------------------- range clearing */

/** Make [from, to) empty on a track by trimming, splitting or removing clips (overwrite edit). */
export function clearRange(p: Project, trackId: string, from: number, to: number, except: Set<string> = new Set()) {
  const fps = p.settings.fps;
  for (const c of clipsOnTrack(p, trackId)) {
    if (except.has(c.id)) continue;
    const s = c.start, e = clipEnd(c);
    if (e <= from || s >= to) continue;
    if (s >= from && e <= to) { remove(p, c.id); continue; }
    if (s < from && e > to) {
      // split into a head and a tail
      const tail = { ...structuredClone(c), id: uid('c'), linkId: null };
      tail.srcIn = c.srcIn + ((to - s) / fps) * c.speed;
      tail.start = to; tail.duration = e - to; tail.transitionIn = null;
      c.duration = from - s;
      p.clips.push(tail);
      continue;
    }
    if (s < from) { c.duration = from - s; continue; }
    // overlaps our end: trim its head
    const cut = to - s;
    c.srcIn += (cut / fps) * c.speed;
    c.start = to; c.duration -= cut; c.transitionIn = null;
  }
}

/** Shift every clip on the given tracks that starts at or after `frame` by `delta` frames. */
export function shiftFrom(p: Project, trackIds: string[], frame: number, delta: number, except: Set<string> = new Set()) {
  for (const c of p.clips) if (trackIds.includes(c.trackId) && c.start >= frame && !except.has(c.id)) c.start += delta;
}

/* --------------------------------------------------------------- editing */

export type EditMode = 'overwrite' | 'insert';

/** Put new clips on the timeline (a video clip and its linked audio, say). */
export function placeClips(p: Project, clips: Clip[], mode: EditMode = 'overwrite') {
  const tracks = [...new Set(clips.map(c => c.trackId))];
  if (mode === 'insert') {
    const at = Math.min(...clips.map(c => c.start));
    const len = Math.max(...clips.map(clipEnd)) - at;
    for (const t of tracks) { for (const c of clipsOnTrack(p, t)) if (c.start < at && clipEnd(c) > at) splitClip(p, c.id, at, false); }
    shiftFrom(p, tracks, at, len);
  } else {
    for (const c of clips) clearRange(p, c.trackId, c.start, clipEnd(c));
  }
  p.clips.push(...clips);
}

/** Split one clip at a frame. Returns the new right-hand clip id. Linked clips split too when `linked`. */
export function splitClip(p: Project, id: string, frame: number, linked = true): string | null {
  const c = p.clips.find(x => x.id === id);
  if (!c || frame <= c.start || frame >= clipEnd(c)) return null;
  const targets = linked && c.linkId ? p.clips.filter(x => x.linkId === c.linkId && frame > x.start && frame < clipEnd(x)) : [c];
  const newLink = targets.length > 1 ? uid('l') : null;
  let rightId: string | null = null;
  for (const t of targets) {
    const right: Clip = { ...structuredClone(t), id: uid('c'), linkId: newLink };
    const cut = frame - t.start;
    right.start = frame; right.duration = t.duration - cut;
    right.srcIn = t.srcIn + (cut / p.settings.fps) * t.speed;
    right.transitionIn = null; right.fadeIn = 0;
    t.duration = cut; t.fadeOut = 0;
    p.clips.push(right);
    if (t.id === id) rightId = right.id;
  }
  return rightId;
}

/** Razor at a frame across tracks (all unlocked tracks when trackIds is omitted). */
export function splitAt(p: Project, frame: number, trackIds?: string[]): number {
  const locked = new Set(p.tracks.filter(t => t.locked).map(t => t.id));
  let n = 0;
  for (const c of [...p.clips]) {
    if (locked.has(c.trackId) || (trackIds && !trackIds.includes(c.trackId))) continue;
    if (frame > c.start && frame < clipEnd(c) && p.clips.includes(c) && splitClip(p, c.id, frame, false)) n++;
  }
  return n;
}

export function deleteClips(p: Project, ids: string[], ripple = false) {
  const all = new Set(withLinked(p, ids));
  const gone = p.clips.filter(c => all.has(c.id));
  p.clips = p.clips.filter(c => !all.has(c.id));
  if (!ripple) return;
  // Close each gap on its track, latest first so earlier shifts don't disturb later ones
  for (const c of gone.sort((a, b) => b.start - a.start)) {
    const blockers = p.clips.filter(x => x.trackId === c.trackId && x.start < clipEnd(c) && clipEnd(x) > c.start);
    if (!blockers.length) shiftFrom(p, [c.trackId], clipEnd(c), -c.duration);
  }
}

/** Remove the empty space at `frame` on a track by pulling later clips left. */
export function closeGap(p: Project, trackId: string, frame: number): number {
  const cs = clipsOnTrack(p, trackId);
  const before = cs.filter(c => clipEnd(c) <= frame).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const after = cs.find(c => c.start >= frame);
  if (!after) return 0;
  const gap = after.start - before;
  if (gap <= 0) return 0;
  const tracks = withLinked(p, [after.id]).map(id => p.clips.find(c => c.id === id)!.trackId);
  shiftFrom(p, [...new Set([trackId, ...tracks])], after.start, -gap);
  return gap;
}

/** Trim a clip edge to `frame`. Overwrites neighbors unless `ripple`, which shifts later clips instead. */
export function trimClip(p: Project, id: string, edge: 'in' | 'out', frame: number, ripple = false) {
  const ids = withLinked(p, [id]);
  const main = p.clips.find(c => c.id === id)!;
  const fps = p.settings.fps;
  if (edge === 'out') {
    let end = Math.max(main.start + 1, frame);
    for (const cid of ids) { const c = p.clips.find(x => x.id === cid)!; end = Math.min(end, c.start + maxDurationFrames(p, c)); }
    const delta = end - clipEnd(main);
    for (const cid of ids) {
      const c = p.clips.find(x => x.id === cid)!;
      const oldEnd = clipEnd(c);
      if (ripple) shiftFrom(p, [c.trackId], oldEnd, delta, new Set(ids));
      c.duration = Math.max(1, c.duration + delta);
      if (!ripple && delta > 0) clearRange(p, c.trackId, oldEnd, clipEnd(c), new Set(ids));
    }
  } else {
    let start = Math.min(clipEnd(main) - 1, frame);
    for (const cid of ids) { const c = p.clips.find(x => x.id === cid)!; start = Math.max(start, minStartFrames(p, c)); }
    const delta = start - main.start;
    for (const cid of ids) {
      const c = p.clips.find(x => x.id === cid)!;
      const oldStart = c.start;
      c.srcIn = Math.max(0, c.srcIn + (delta / fps) * c.speed);
      c.start += delta; c.duration -= delta;
      if (!ripple && delta < 0) clearRange(p, c.trackId, c.start, oldStart, new Set(ids));
      if (ripple) { c.start = oldStart; shiftFrom(p, [c.trackId], clipEnd(c) + delta, -delta, new Set(ids)); }
    }
  }
}

/**
 * Move clips by a number of frames and tracks; overwrites whatever is underneath.
 * `trackDelta` can differ per kind so dragging a video clip up a track leaves its audio where it is.
 * `linked` = false moves only the given clips (Alt-drag).
 */
export function moveClips(p: Project, ids: string[], deltaFrames: number, trackDelta: number | { video: number; audio: number } = 0, linked = true) {
  const all = linked ? withLinked(p, ids) : ids;
  const moving = p.clips.filter(c => all.includes(c.id));
  if (!moving.length) return;
  const minStart = Math.min(...moving.map(c => c.start));
  const d = Math.max(-minStart, deltaFrames);
  const kindOf = (c: Clip) => p.tracks.find(x => x.id === c.trackId)!.kind;
  for (const c of moving) {
    c.start += d;
    const kind = kindOf(c);
    const td = typeof trackDelta === 'number' ? trackDelta : trackDelta[kind];
    if (td) {
      const same = p.tracks.filter(t => t.kind === kind);
      const i = same.findIndex(t => t.id === c.trackId);
      const ni = Math.min(same.length - 1, Math.max(0, i + td));
      if (!same[ni].locked) c.trackId = same[ni].id;
    }
  }
  const except = new Set(all);
  for (const c of moving) clearRange(p, c.trackId, c.start, clipEnd(c), except);
}

/** Snap a frame to nearby clip edges, markers and the playhead. */
export function snapFrame(p: Project, frame: number, threshold: number, exclude: Set<string>, extra: number[] = []): { frame: number; snapped: boolean } {
  let best = frame, bestD = threshold + 1;
  const consider = (f: number) => { const d = Math.abs(f - frame); if (d < bestD) { bestD = d; best = f; } };
  consider(0);
  for (const c of p.clips) if (!exclude.has(c.id)) { consider(c.start); consider(clipEnd(c)); }
  for (const m of p.markers) consider(m.frame);
  for (const f of extra) consider(f);
  return bestD <= threshold ? { frame: best, snapped: true } : { frame, snapped: false };
}

/* ------------------------------------------------- creating clips from media */

export function clipsForMedia(p: Project, mediaId: string, start: number, opts: { videoTrack?: string; audioTrack?: string; srcIn?: number; srcOut?: number; imageSeconds?: number } = {}): Clip[] {
  const m = mediaOf(p, mediaId)!;
  const fps = p.settings.fps;
  const srcIn = opts.srcIn ?? 0;
  const len = m.kind === 'image' ? Math.round((opts.imageSeconds ?? 5) * fps) : Math.max(1, Math.floor(((opts.srcOut ?? m.duration) - srcIn) * fps + 1e-6));
  const vt = opts.videoTrack ?? p.tracks.find(t => t.kind === 'video' && !t.locked)?.id;
  const at = opts.audioTrack ?? p.tracks.find(t => t.kind === 'audio' && !t.locked)?.id;
  const link = m.hasVideo && m.hasAudio ? uid('l') : null;
  const out: Clip[] = [];
  if ((m.hasVideo || m.kind === 'image') && vt) out.push(newClip({ trackId: vt, kind: 'media', mediaId, name: m.name, start, duration: len, srcIn, linkId: link }));
  if (m.hasAudio && at) out.push(newClip({ trackId: at, kind: 'media', mediaId, name: m.name, start, duration: len, srcIn, linkId: link }));
  return out;
}

/* ---------------------------------------------------- render resolution */

export interface VideoSegment {
  clip: Clip;
  track: Track;
  /** Layer order: 0 = bottom */
  layer: number;
  /** Frames on the timeline this segment draws (may extend past the clip for a transition tail) */
  from: number;
  to: number;
  /** Source seconds at `from` */
  srcAt: number;
  /** Alpha ramps (frames, timeline time): value goes 0→1 for 'in', 1→0 for 'out' */
  alphaIn?: { start: number; dur: number };
  /** Fade to/from black */
  blackIn?: { start: number; dur: number };
  blackOut?: { start: number; dur: number };
  slideIn?: { start: number; dur: number };
}

export function videoSegments(p: Project): VideoSegment[] {
  const out: VideoSegment[] = [];
  const vts = p.tracks.filter(t => t.kind === 'video');
  vts.forEach((track, layer) => {
    if (track.hidden) return;
    const cs = clipsOnTrack(p, track.id).filter(c => c.enabled);
    cs.forEach((c, i) => {
      const next = cs[i + 1];
      const prev = cs[i - 1];
      const seg: VideoSegment = { clip: c, track, layer, from: c.start, to: clipEnd(c), srcAt: c.srcIn };
      // Our tail extends under the next clip's dissolve/slide
      const tr = next?.transitionIn;
      if (next && tr && next.start === clipEnd(c) && (tr.type === 'dissolve' || tr.type === 'slide')) seg.to += Math.min(tr.duration, next.duration);
      if (next && tr && next.start === clipEnd(c) && tr.type === 'dip') { const h = Math.floor(tr.duration / 2); seg.blackOut = { start: clipEnd(c) - h, dur: h }; }
      const ti = c.transitionIn;
      if (ti) {
        const d = Math.min(ti.duration, c.duration);
        const adjacent = prev && clipEnd(prev) === c.start;
        if (ti.type === 'dissolve') seg.alphaIn = { start: c.start, dur: d };
        else if (ti.type === 'slide') seg.slideIn = { start: c.start, dur: d };
        else seg.blackIn = { start: c.start, dur: adjacent ? Math.ceil(d / 2) : d };
      }
      if (c.fadeIn > 0 && !seg.blackIn) seg.blackIn = { start: c.start, dur: Math.min(c.fadeIn, c.duration) };
      if (c.fadeOut > 0 && !seg.blackOut) seg.blackOut = { start: clipEnd(c) - Math.min(c.fadeOut, c.duration), dur: Math.min(c.fadeOut, c.duration) };
      out.push(seg);
    });
  });
  return out;
}

const ramp = (r: { start: number; dur: number } | undefined, f: number) => (!r ? 1 : r.dur <= 0 ? 1 : Math.min(1, Math.max(0, (f - r.start) / r.dur)));

export interface LayerState { seg: VideoSegment; srcTime: number; alpha: number; black: number; slide: number }

/** Evaluate a segment at a timeline frame (alpha/black/slide in 0..1). */
export function evalSegment(p: Project, seg: VideoSegment, frame: number): LayerState {
  const c = seg.clip;
  const srcTime = seg.srcAt + ((frame - seg.from) / p.settings.fps) * c.speed;
  const alpha = c.opacity * ramp(seg.alphaIn, frame);
  let black = 0;
  if (seg.blackIn) black = Math.max(black, 1 - ramp(seg.blackIn, frame));
  if (seg.blackOut) black = Math.max(black, ramp(seg.blackOut, frame));
  const slide = seg.slideIn ? 1 - ramp(seg.slideIn, frame) : 0;
  return { seg, srcTime, alpha, black, slide };
}

/** Layers visible at a frame, bottom to top. */
export function layersAt(p: Project, frame: number, segs = videoSegments(p)): LayerState[] {
  return segs.filter(s => frame >= s.from && frame < s.to)
    // tails of outgoing clips sit below the incoming clip on the same track
    .sort((a, b) => a.layer - b.layer || (a.clip.start - b.clip.start))
    .map(s => evalSegment(p, s, frame));
}

export interface AudioSegment {
  clip: Clip;
  track: Track;
  from: number;
  to: number;
  srcAt: number;
  gainDb: number;
  pan: number;
}

export function audioSegments(p: Project): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const track of p.tracks.filter(t => t.kind === 'audio')) {
    if (!trackAudible(p, track)) continue;
    for (const c of clipsOnTrack(p, track.id)) {
      if (!c.enabled || c.kind !== 'media') continue;
      const m = mediaOf(p, c.mediaId);
      if (!m?.hasAudio) continue;
      out.push({ clip: c, track, from: c.start, to: clipEnd(c), srcAt: c.srcIn, gainDb: c.volume + track.volume, pan: track.pan });
    }
  }
  return out;
}

/** Clip gain (linear multiplier of the dB setting) including fades, at a frame. */
export function fadeGain(c: Clip, frame: number): number {
  const t = frame - c.start, rem = clipEnd(c) - frame;
  let g = 1;
  if (c.fadeIn > 0 && t < c.fadeIn) g *= Math.max(0, t / c.fadeIn);
  if (c.fadeOut > 0 && rem < c.fadeOut) g *= Math.max(0, rem / c.fadeOut);
  return g;
}

/* ----------------------------------------------------------- geometry */

export interface Placement {
  /** Size of the cropped image after scaling, project px */
  w: number; h: number;
  /** Center position, project px from the top-left */
  cx: number; cy: number;
  rotation: number;
  /** Crop in source fractions */
  crop: [number, number, number, number];
}

/** Where a clip's picture lands in the frame (same math for preview and export). */
export function placement(p: Project, c: Clip, srcW: number, srcH: number): Placement {
  const { width: W, height: H } = p.settings;
  const t = c.transform;
  const fit = Math.min(W / srcW, H / srcH);
  const cw = srcW * (1 - t.cropL - t.cropR), ch = srcH * (1 - t.cropT - t.cropB);
  const w = Math.max(2, cw * fit * t.scale), h = Math.max(2, ch * fit * t.scale);
  // Cropping keeps the remaining area where it was in the uncropped frame
  const shiftX = ((t.cropL - t.cropR) / 2) * srcW * fit * t.scale;
  const shiftY = ((t.cropT - t.cropB) / 2) * srcH * fit * t.scale;
  return { w, h, cx: W / 2 + t.x + shiftX, cy: H / 2 + t.y + shiftY, rotation: t.rotation, crop: [t.cropL, t.cropT, t.cropR, t.cropB] };
}
