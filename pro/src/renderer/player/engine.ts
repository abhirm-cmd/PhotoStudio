/**
 * Program playback engine. Owns the program monitor canvas, one decoder
 * element per visible clip, the Web Audio mix and the playback clock.
 * Paused, it seeks every visible layer to the exact frame; playing, it lets
 * the elements run and corrects drift against the clock.
 */
import { type Project, type Clip, type MediaItem, mediaOf, projectDuration, dbToGain, trackAudible } from '@shared/project';
import { videoSegments, layersAt, audioSegments, fadeGain, placement, type VideoSegment, type AudioSegment } from '@shared/timeline';
import { bakeLut, gradeKey, isNeutral, parseCube, type Lut3D, type Grade } from '@shared/grade';
import { Compositor, type DrawLayer } from './compositor';
import { drawTitle } from './titles';
import { api, fileUrl, cacheUrl } from '../api';
import { useProject } from '../store/project';
import { usePlayer } from '../store/player';

export const mediaUrl = (m: MediaItem) => (m.proxy ? cacheUrl(m.proxy) : fileUrl(m.path));

/* --------------------------------------------------------------- LUTs */

const cubeCache = new Map<string, Lut3D | null | Promise<void>>();
const bakeCache = new Map<string, Lut3D>();

/** Parsed imported LUT, loading it in the background on first use. */
export function importedLut(path: string, onLoad?: () => void): Lut3D | null | undefined {
  const c = cubeCache.get(path);
  if (c instanceof Promise) return undefined;
  if (c !== undefined) return c;
  cubeCache.set(path, api.readLut(path).then(t => { try { cubeCache.set(path, t ? parseCube(t) : null); } catch { cubeCache.set(path, null); } onLoad?.(); }));
  return undefined;
}

/** Baked LUT for a grade, or null when the grade is neutral. `undefined` while an imported LUT loads. */
export function gradeLut(g: Grade, onLoad?: () => void): { key: string; lut: Lut3D } | null | undefined {
  if (isNeutral(g)) return null;
  let imported: Lut3D | null = null;
  if (g.lut) { const l = importedLut(g.lut.path, onLoad); if (l === undefined) return undefined; imported = l; }
  const key = gradeKey(g);
  let lut = bakeCache.get(key);
  if (!lut) {
    lut = bakeLut(g, imported);
    bakeCache.set(key, lut);
    if (bakeCache.size > 200) bakeCache.delete(bakeCache.keys().next().value!);
  }
  return { key, lut };
}

/* ---------------------------------------------------------------- audio */

interface Bus { gain: GainNode; l: GainNode; r: GainNode; split: ChannelSplitterNode; merge: ChannelMergerNode; meterL: AnalyserNode; meterR: AnalyserNode }
interface Voice { el: HTMLAudioElement; src: MediaElementAudioSourceNode; gain: GainNode; trackId: string; url: string; seen: number; synced: number }

class AudioMix {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  master: GainNode;
  masterMeter: [AnalyserNode, AnalyserNode];
  buses = new Map<string, Bus>();
  voices = new Map<string, Voice>();
  private buf = new Float32Array(1024);

  constructor() {
    this.master = this.ctx.createGain();
    const split = this.ctx.createChannelSplitter(2);
    this.masterMeter = [this.analyser(), this.analyser()];
    this.master.connect(this.ctx.destination);
    this.master.connect(split);
    split.connect(this.masterMeter[0], 0);
    split.connect(this.masterMeter[1], 1);
  }
  private analyser() { const a = this.ctx.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0; return a; }

  bus(trackId: string): Bus {
    let b = this.buses.get(trackId);
    if (b) return b;
    const c = this.ctx;
    const gain = c.createGain(), split = c.createChannelSplitter(2), merge = c.createChannelMerger(2), l = c.createGain(), r = c.createGain();
    gain.channelCount = 2; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'speakers';
    // Balance like the export: each side's gain is min(1, 1 ∓ pan)
    gain.connect(split); split.connect(l, 0); split.connect(r, 1); l.connect(merge, 0, 0); r.connect(merge, 0, 1);
    merge.connect(this.master);
    const meterL = this.analyser(), meterR = this.analyser();
    l.connect(meterL); r.connect(meterR);
    b = { gain, l, r, split, merge, meterL, meterR };
    this.buses.set(trackId, b);
    return b;
  }

  voice(clip: Clip, url: string): Voice {
    let v = this.voices.get(clip.id);
    if (v && v.url !== url) { this.drop(clip.id); v = undefined; }
    if (!v) {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.preservesPitch = true;
      el.src = url;
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      gain.channelCount = 2; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'speakers';
      src.connect(gain);
      v = { el, src, gain, trackId: '', url, seen: 0, synced: 0 };
      this.voices.set(clip.id, v);
    }
    if (v.trackId !== clip.trackId) { v.gain.disconnect(); v.gain.connect(this.bus(clip.trackId).gain); v.trackId = clip.trackId; }
    return v;
  }

  drop(id: string) {
    const v = this.voices.get(id);
    if (!v) return;
    v.el.pause(); v.el.removeAttribute('src'); v.el.load();
    v.src.disconnect(); v.gain.disconnect();
    this.voices.delete(id);
  }

  peak(a: AnalyserNode) {
    a.getFloatTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < this.buf.length; i++) { const x = Math.abs(this.buf[i]); if (x > m) m = x; }
    return m;
  }
}

/* --------------------------------------------------------------- engine */

interface VideoSlot { el: HTMLVideoElement; url: string; seen: number }

export class ProgramEngine {
  canvas = document.createElement('canvas');
  comp: Compositor;
  private videos = new Map<string, VideoSlot>();
  private images = new Map<string, HTMLImageElement>();
  private titles = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  private colors = new Map<string, HTMLCanvasElement>();
  audio: AudioMix | null = null;
  private dirty = true;
  private raf = 0;
  private tick = 0;
  private clock = { t0: 0, f0: 0, rate: 1 };
  private segs: VideoSegment[] = [];
  private aSegs: AudioSegment[] = [];
  private segsFor: Project | null = null;
  /** For tests and the status bar: what the last render drew */
  last = { frame: -1, layers: 0, pending: 0, missing: 0 };
  private renderListeners = new Set<() => void>();
  /** Called after every program render (scopes, status). Returns an unsubscribe function. */
  onRendered(fn: () => void) { this.renderListeners.add(fn); return () => { this.renderListeners.delete(fn); }; }

  constructor() {
    this.canvas.className = 'program-canvas';
    this.comp = new Compositor(this.canvas);
    useProject.subscribe((s, prev) => { if (s.project !== prev.project) this.invalidate(); });
    usePlayer.subscribe((s, prev) => {
      if (s.playing !== prev.playing || (s.playing && s.rate !== prev.rate)) this.startClock();
      if (s.frame !== prev.frame && !s.playing) this.invalidate();
    });
    this.raf = requestAnimationFrame(this.loop);
  }

  invalidate = () => { this.dirty = true; };

  private ensureAudio() {
    if (!this.audio) this.audio = new AudioMix();
    if (this.audio.ctx.state === 'suspended') void this.audio.ctx.resume();
    return this.audio;
  }

  private startClock() {
    const pl = usePlayer.getState();
    this.clock = { t0: performance.now(), f0: pl.frame, rate: pl.rate };
    if (pl.playing) this.ensureAudio();
    else this.pauseAll();
    this.dirty = true;
  }

  private pauseAll() {
    for (const v of this.videos.values()) if (!v.el.paused) v.el.pause();
    if (this.audio) for (const v of this.audio.voices.values()) if (!v.el.paused) v.el.pause();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.tick++;
    const pl = usePlayer.getState();
    const p = useProject.getState().project;
    if (this.segsFor !== p) { this.segs = videoSegments(p); this.aSegs = audioSegments(p); this.segsFor = p; }
    const fps = p.settings.fps;
    let frame = pl.frame;
    if (pl.playing) {
      const end = pl.loop && p.outPoint != null ? p.outPoint : projectDuration(p);
      const start = pl.loop && p.inPoint != null ? p.inPoint : 0;
      const f = this.clock.f0 + ((performance.now() - this.clock.t0) / 1000) * fps * this.clock.rate;
      if (this.clock.rate > 0 && f >= end) {
        if (pl.loop && end > start) { this.clock = { t0: performance.now(), f0: start, rate: this.clock.rate }; frame = start; this.seekAllAudio(); }
        else { usePlayer.setState({ playing: false, rate: 1, frame: Math.max(0, end - 1) }); return; }
      } else if (this.clock.rate < 0 && f <= 0) { usePlayer.setState({ playing: false, rate: 1, frame: 0 }); return; }
      else frame = Math.floor(f);
      if (frame !== pl.frame) usePlayer.setState({ frame });
      this.syncAudio(p, frame, true);
      this.render(p, frame, true);
      return;
    }
    if (this.dirty) { this.dirty = false; this.syncAudio(p, frame, false); this.render(p, frame, false); }
    if (this.tick % 90 === 0) this.gc();
  };

  private seekAllAudio() { if (this.audio) for (const v of this.audio.voices.values()) v.el.pause(); }

  /* ------------------------------------------------------------- video */

  private videoFor(seg: VideoSegment, m: MediaItem): VideoSlot {
    const url = mediaUrl(m);
    let s = this.videos.get(seg.clip.id);
    if (s && s.url !== url) { this.dropVideo(seg.clip.id); s = undefined; }
    if (!s) {
      const el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.src = url;
      const slot: VideoSlot = { el, url, seen: 0 };
      el.addEventListener('seeked', () => { this.dirty = true; });
      el.addEventListener('loadeddata', () => { this.dirty = true; });
      el.addEventListener('error', () => { this.dirty = true; });
      this.videos.set(seg.clip.id, slot);
      s = slot;
    }
    s.seen = this.tick;
    return s;
  }

  private dropVideo(id: string) {
    const s = this.videos.get(id);
    if (!s) return;
    s.el.pause(); s.el.removeAttribute('src'); s.el.load();
    this.videos.delete(id);
  }

  private gc() {
    for (const [id, s] of this.videos) if (this.tick - s.seen > 600) this.dropVideo(id);
    if (this.audio) for (const [id, v] of this.audio.voices) if (this.tick - v.seen > 600) this.audio.drop(id);
  }

  private imageFor(m: MediaItem) {
    let img = this.images.get(m.id);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => { this.dirty = true; };
      img.src = fileUrl(m.path);
      this.images.set(m.id, img);
    }
    return img;
  }

  private titleFor(p: Project, c: Clip) {
    const key = `title:${c.id}:${JSON.stringify(c.title)}:${p.settings.width}x${p.settings.height}`;
    let t = this.titles.get(c.id);
    if (!t || t.key !== key) {
      if (t) this.comp.invalidate(t.key);
      // Titles render at up to 1920 wide for the preview; export renders at full size
      const s = Math.min(1, 1920 / p.settings.width);
      const canvas = drawTitle({ ...c.title!, size: c.title!.size * s }, Math.round(p.settings.width * s), Math.round(p.settings.height * s)) as HTMLCanvasElement;
      t = { key, canvas };
      this.titles.set(c.id, t);
    }
    return t;
  }

  private colorFor(hex: string) {
    let c = this.colors.get(hex);
    if (!c) { c = document.createElement('canvas'); c.width = c.height = 4; const g = c.getContext('2d')!; g.fillStyle = hex; g.fillRect(0, 0, 4, 4); this.colors.set(hex, c); }
    return c;
  }

  private render(p: Project, frame: number, playing: boolean) {
    const fps = p.settings.fps;
    this.comp.resize(p.settings.width, p.settings.height, Math.min(1920, Math.max(640, (this.canvas.clientWidth || 960) * devicePixelRatio)));
    const layers = layersAt(p, frame, this.segs);
    const draw: DrawLayer[] = [];
    let pending = 0, missing = 0;
    const active = new Set<string>();
    for (const L of layers) {
      const c = L.seg.clip;
      let source: TexImageSource | null = null, key = '', dynamic = false, sw = p.settings.width, sh = p.settings.height;
      if (c.kind === 'title' && c.title) { const t = this.titleFor(p, c); source = t.canvas; key = t.key; }
      else if (c.kind === 'color') { source = this.colorFor(c.color ?? '#000000'); key = `color:${c.color}`; }
      else {
        const m = mediaOf(p, c.mediaId);
        if (!m || m.missing) { missing++; continue; }
        sw = m.width; sh = m.height;
        if (m.kind === 'image') {
          const img = this.imageFor(m);
          if (!img.complete || !img.naturalWidth) { pending++; continue; }
          source = img; key = `img:${m.id}`;
        } else {
          const s = this.videoFor(L.seg, m);
          active.add(c.id);
          const el = s.el;
          const dur = el.duration || m.duration;
          const t = Math.min(Math.max(0, L.srcTime), Math.max(0, dur - 0.5 / (m.fps || fps)));
          if (playing && usePlayer.getState().rate > 0) {
            const rate = Math.min(16, c.speed * usePlayer.getState().rate);
            if (el.paused && el.readyState >= 1) { if (!el.seeking) el.currentTime = t; el.playbackRate = rate; void el.play().catch(() => {}); }
            else if (!el.seeking && el.readyState >= 3) {
              const drift = t - el.currentTime;
              if (Math.abs(drift) > 1) el.currentTime = t;
              else el.playbackRate = rate * (1 + Math.max(-0.15, Math.min(0.15, drift * 0.6)));
            }
          } else {
            if (!el.paused) el.pause();
            if (el.readyState >= 1 && Math.abs(el.currentTime - t) > 0.4 / (m.fps || fps) && !el.seeking) el.currentTime = t;
            if (el.seeking) pending++;
          }
          if (el.readyState < 2) { pending++; continue; }
          source = el; key = `v:${c.id}`; dynamic = true;
        }
      }
      if (!source) continue;
      const lut = c.kind === 'media' ? gradeLut(c.grade, this.invalidate) : null;
      if (lut === undefined) pending++;
      const pl = placement(p, c, sw, sh, frame);
      draw.push({
        source, key, dynamic,
        center: [pl.cx + L.slide * p.settings.width, pl.cy], size: [pl.w, pl.h], rotation: pl.rotation,
        flip: [c.transform.flipH, c.transform.flipV], crop: pl.crop,
        alpha: L.alpha, black: L.black, lut: lut ?? null,
      });
    }
    // Pre-roll clips that start soon so cuts don't flash black
    const ahead = frame + Math.round(fps * (playing ? 1.5 : 0.5));
    for (const s of this.segs) {
      if (active.has(s.clip.id) || s.from <= frame || s.from > ahead || s.clip.kind !== 'media') continue;
      const m = mediaOf(p, s.clip.mediaId);
      if (!m || m.kind !== 'video' || m.missing) continue;
      const slot = this.videoFor(s, m);
      if (!slot.el.paused && !playing) slot.el.pause();
      if (slot.el.paused && slot.el.readyState >= 1 && Math.abs(slot.el.currentTime - s.srcAt) > 0.05 && !slot.el.seeking) slot.el.currentTime = s.srcAt;
      active.add(s.clip.id);
    }
    for (const [id, s] of this.videos) if (!active.has(id) && !s.el.paused) s.el.pause();
    this.comp.draw(draw);
    this.last = { frame, layers: draw.length, pending, missing };
    for (const fn of this.renderListeners) fn();
    if (pending && !playing) setTimeout(this.invalidate, 60);
  }

  /* -------------------------------------------------------------- audio */

  private syncAudio(p: Project, frame: number, playing: boolean) {
    if (!this.audio && !playing) return;
    const mix = this.ensureAudio();
    const fps = p.settings.fps;
    const rate = usePlayer.getState().rate;
    const now = mix.ctx.currentTime;
    for (const t of p.tracks) {
      if (t.kind !== 'audio') continue;
      const b = mix.bus(t.id);
      b.gain.gain.setTargetAtTime(trackAudible(p, t) ? dbToGain(t.volume) : 0, now, 0.015);
      b.l.gain.setTargetAtTime(Math.min(1, 1 - t.pan), now, 0.015);
      b.r.gain.setTargetAtTime(Math.min(1, 1 + t.pan), now, 0.015);
    }
    const live = new Set<string>();
    if (playing && rate > 0 && rate <= 4) {
      for (const s of this.aSegs) {
        if (frame < s.from - fps || frame >= s.to) continue;
        const m = mediaOf(p, s.clip.mediaId);
        if (!m || m.missing) continue;
        const v = mix.voice(s.clip, mediaUrl(m));
        v.seen = this.tick;
        live.add(s.clip.id);
        const want = s.srcAt + ((frame - s.from) / fps) * s.clip.speed;
        if (frame < s.from) { if (!v.el.paused) v.el.pause(); if (Math.abs(v.el.currentTime - s.srcAt) > 0.05) v.el.currentTime = s.srcAt; continue; }
        const r = s.clip.speed * rate;
        v.gain.gain.setTargetAtTime(dbToGain(s.clip.volume) * fadeGain(s.clip, frame), now, 0.01);
        // Start in sync; afterwards steer small drift with the playback rate (seeking an
        // element that is still buffering only makes it fall further behind)
        const t = performance.now();
        if (v.el.paused) { if (!v.el.seeking) { v.el.currentTime = want; v.synced = t; } v.el.playbackRate = r; void v.el.play().catch(() => {}); }
        else if (!v.el.seeking && v.el.readyState >= 3) {
          const drift = want - v.el.currentTime;
          if (Math.abs(drift) > 1 && t - v.synced > 1000) { v.el.currentTime = want; v.synced = t; }
          else v.el.playbackRate = r * (1 + Math.max(-0.15, Math.min(0.15, drift * 0.6)));
        }
      }
    }
    for (const [id, v] of mix.voices) if (!live.has(id) && !v.el.paused) v.el.pause();
  }

  /** Peak levels (linear) per audio track and the master, for meters. */
  meters(): { tracks: Record<string, [number, number]>; master: [number, number] } {
    const out: Record<string, [number, number]> = {};
    if (!this.audio) return { tracks: out, master: [0, 0] };
    const playing = usePlayer.getState().playing;
    for (const [id, b] of this.audio.buses) out[id] = playing ? [this.audio.peak(b.meterL), this.audio.peak(b.meterR)] : [0, 0];
    const m = this.audio.masterMeter;
    return { tracks: out, master: playing ? [this.audio.peak(m[0]), this.audio.peak(m[1])] : [0, 0] };
  }

  /** The current frame as PNG bytes at project resolution (for "Export frame"). */
  async snapshotPng(): Promise<Uint8Array> {
    const p = useProject.getState().project;
    const prev = this.canvas.width;
    this.comp.resize(p.settings.width, p.settings.height, p.settings.width);
    this.render(p, usePlayer.getState().frame, false);
    const blob: Blob = await new Promise((res, rej) => this.canvas.toBlob(b => (b ? res(b) : rej(new Error('Snapshot failed'))), 'image/png'));
    this.comp.resize(p.settings.width, p.settings.height, prev);
    this.dirty = true;
    return new Uint8Array(await blob.arrayBuffer());
  }
}

let engine: ProgramEngine | null = null;
export const getEngine = () => (engine ??= new ProgramEngine());
