/**
 * PhotoStudio Pro project model.
 *
 * Timeline positions are integer frames at the project frame rate. Source
 * positions (where a clip starts reading its media) are in seconds, because
 * media can have any frame rate.
 */
import { defaultGrade, type Grade } from './grade';

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  /** Seconds (images: 0, they can be any length on the timeline) */
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
  sampleRate?: number;
  /** Rotation from container metadata (degrees, clockwise as displayed) */
  rotation: number;
  colorSpace?: string;
  size: number;
  /** Cache keys of generated assets */
  thumbs?: { key: string; count: number; interval: number; width: number; height: number } | null;
  waveform?: { key: string; rate: number } | null;
  /** H.264 preview proxy (cache key) for formats the player can't decode, like ProRes or HEVC */
  proxy?: string | null;
  missing?: boolean;
  importedAt: string;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  /** Video tracks: hide from the output */
  hidden: boolean;
  /** Audio tracks: fader in dB and pan -1..1 */
  volume: number;
  pan: number;
}

export interface Transform {
  /** 1 = fit inside the frame */
  scale: number;
  /** Offset of the clip center from the frame center, in project pixels */
  x: number;
  y: number;
  rotation: number;
  cropL: number; cropR: number; cropT: number; cropB: number;
  flipH: boolean;
  flipV: boolean;
}

/** A crop window in fractions of the source picture (Match Edit zoom/pan moves) */
export interface MotionRect { x: number; y: number; w: number; h: number }

export type TransitionType = 'dissolve' | 'dip' | 'slide';
export interface Transition { type: TransitionType; duration: number }

export interface TitleSpec {
  text: string;
  font: string;
  size: number;        // px at project resolution
  weight: number;      // 400..900
  color: string;
  align: 'left' | 'center' | 'right';
  /** Position of the text block center, 0..1 of the frame */
  x: number;
  y: number;
  box: boolean;
  boxColor: string;
  boxOpacity: number;  // 0..1
  shadow: boolean;
}

export type ClipKind = 'media' | 'title' | 'color';

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  mediaId?: string;
  name: string;
  /** Timeline position and length in frames */
  start: number;
  duration: number;
  /** Source in-point, seconds */
  srcIn: number;
  speed: number;
  enabled: boolean;
  /** Clips that move and trim together (video + its audio) */
  linkId?: string | null;
  // video
  opacity: number;
  transform: Transform;
  grade: Grade;
  transitionIn?: Transition | null;
  /** Animated zoom/pan: the visible window of the source moves from `from` to `to` over the clip */
  motion?: { from: MotionRect; to: MotionRect } | null;
  title?: TitleSpec;
  color?: string;
  // audio
  volume: number;   // dB
  fadeIn: number;   // frames
  fadeOut: number;  // frames
  labelColor?: string;
}

export interface Marker { id: string; frame: number; name: string; color: string }

export interface Project {
  version: 1;
  name: string;
  settings: ProjectSettings;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  /** In/out range for playback loops and export (frames) */
  inPoint: number | null;
  outPoint: number | null;
  createdAt: string;
  modifiedAt: string;
}

let seq = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const defaultTransform = (): Transform => ({ scale: 1, x: 0, y: 0, rotation: 0, cropL: 0, cropR: 0, cropT: 0, cropB: 0, flipH: false, flipV: false });

export const defaultTitle = (): TitleSpec => ({
  text: 'Title', font: 'Inter Variable', size: 96, weight: 700, color: '#ffffff', align: 'center', x: 0.5, y: 0.5,
  box: false, boxColor: '#000000', boxOpacity: 0.5, shadow: true,
});

export function newTrack(kind: TrackKind, index: number): Track {
  return { id: uid('t'), kind, name: `${kind === 'video' ? 'V' : 'A'}${index}`, muted: false, solo: false, locked: false, hidden: false, volume: 0, pan: 0 };
}

export function newProject(name = 'Untitled', settings: Partial<ProjectSettings> = {}): Project {
  const now = new Date().toISOString();
  return {
    version: 1, name,
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, ...settings },
    media: [],
    // Video tracks are listed bottom-up (V1 is the base layer); audio A1..An
    tracks: [newTrack('video', 1), newTrack('video', 2), newTrack('video', 3), newTrack('audio', 1), newTrack('audio', 2), newTrack('audio', 3)],
    clips: [], markers: [], inPoint: null, outPoint: null, createdAt: now, modifiedAt: now,
  };
}

export function newClip(p: Partial<Clip> & Pick<Clip, 'trackId' | 'kind' | 'start' | 'duration'>): Clip {
  return {
    id: uid('c'), name: 'Clip', srcIn: 0, speed: 1, enabled: true, linkId: null, opacity: 1,
    transform: defaultTransform(), grade: defaultGrade(), transitionIn: null, motion: null, volume: 0, fadeIn: 0, fadeOut: 0, ...p,
  };
}

/** Normalize a loaded project (older files, missing fields). */
export function normalizeProject(p: any): Project {
  const base = newProject(p?.name ?? 'Untitled', p?.settings);
  const proj: Project = { ...base, ...p, settings: { ...base.settings, ...(p?.settings ?? {}) } };
  proj.media = (proj.media ?? []).map(m => ({ ...m, rotation: m.rotation ?? 0 }));
  proj.tracks = (proj.tracks?.length ? proj.tracks : base.tracks).map(t => ({ ...newTrack(t.kind, 1), ...t }));
  proj.clips = (proj.clips ?? []).map(c => {
    const n = newClip(c);
    n.id = c.id;
    n.transform = { ...defaultTransform(), ...(c.transform ?? {}) };
    n.grade = { ...defaultGrade(), ...(c.grade ?? {}) };
    if (c.kind === 'title') n.title = { ...defaultTitle(), ...(c.title ?? {}) };
    return n;
  });
  proj.markers = proj.markers ?? [];
  return proj;
}

/* ---------------------------------------------------------------- queries */

export const clipEnd = (c: Clip) => c.start + c.duration;
/** Seconds of source a clip consumes */
export const srcDuration = (c: Clip, fps: number) => (c.duration / fps) * c.speed;
export const srcOut = (c: Clip, fps: number) => c.srcIn + srcDuration(c, fps);

export function projectDuration(p: Project): number {
  return p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export const trackOf = (p: Project, id: string) => p.tracks.find(t => t.id === id);
export const mediaOf = (p: Project, id?: string) => (id ? p.media.find(m => m.id === id) : undefined);
export const videoTracks = (p: Project) => p.tracks.filter(t => t.kind === 'video');
export const audioTracks = (p: Project) => p.tracks.filter(t => t.kind === 'audio');

export function clipsOnTrack(p: Project, trackId: string): Clip[] {
  return p.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

/** Frames ↔ timecode HH:MM:SS:FF */
export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const fr = Math.round(fps);
  const ff = f % fr, s = Math.floor(f / fr);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export function parseTimecode(tc: string, fps: number): number | null {
  const parts = tc.trim().split(/[:;.]/).map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, s, f] = parts.slice(-4);
  return Math.round(((h * 60 + m) * 60 + s) * Math.round(fps) + f);
}

/** Is this audio track audible given solo states? */
export function trackAudible(p: Project, t: Track) {
  if (t.muted) return false;
  const anySolo = p.tracks.some(x => x.kind === 'audio' && x.solo);
  return !anySolo || t.solo;
}

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
