/** Program monitor (the timeline, through the GPU engine) and source monitor (one media item, with in/out marks). */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, StepBack, StepForward, Repeat, Camera, CornerDownRight, ArrowDownToLine, Grid3x3, GripVertical } from 'lucide-react';
import { timecode, projectDuration, clipEnd, type MediaItem } from '@shared/project';
import { placement } from '@shared/timeline';
import { useProject, P } from '../store/project';
import { usePlayer } from '../store/player';
import { useUI, toast } from '../store/ui';
import { getEngine, mediaUrl } from '../player/engine';
import { api, cacheUrl, fileUrl } from '../api';
import * as A from '../services/actions';
import { MEDIA_DND } from '../timeline/Timeline';

/** Size a box of aspect `ar` to fit inside the element. */
function useFit(ar: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - 16, H = el.clientHeight - 16;
      const w = Math.max(10, Math.min(W, H * ar)), h = w / ar;
      setSize({ w: Math.floor(w), h: Math.floor(h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ar]);
  return { ref, size };
}

/* -------------------------------------------------------------- program */

export function ProgramMonitor({ compact, showTransform = true }: { compact?: boolean; showTransform?: boolean }) {
  const p = useProject(s => s.project);
  const { ref, size } = useFit(p.settings.width / p.settings.height);
  const host = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState(false);
  const [status, setStatus] = useState({ missing: 0 });
  const active = useUI(s => s.activeMonitor === 'program');

  useEffect(() => {
    const eng = getEngine();
    host.current!.appendChild(eng.canvas);
    eng.invalidate();
    let t = 0;
    const off = eng.onRendered(() => { const now = performance.now(); if (now - t > 300) { t = now; setStatus(s => (s.missing === eng.last.missing ? s : { missing: eng.last.missing })); } });
    return () => { off(); eng.canvas.remove(); };
  }, []);
  useEffect(() => { getEngine().invalidate(); }, [size.w, size.h]);

  return (
    <div className={`monitor program${active ? ' active' : ''}`} onPointerDown={() => useUI.getState().setActiveMonitor('program')}>
      <div className="monitor-head"><span className="mon-title">Program</span><span className="dim">{p.name}</span><span className="grow" /><span className="dim small">{p.settings.width}×{p.settings.height} · {p.settings.fps} fps</span></div>
      <div className="monitor-view" ref={ref}>
        <div className="monitor-frame" style={{ width: size.w, height: size.h }} ref={host} data-testid="program-monitor">
          {showTransform && <TransformOverlay w={size.w} h={size.h} />}
          {guides && <div className="safe-guides"><div className="action" /><div className="title" /></div>}
          {status.missing > 0 && <div className="mon-msg">Media offline — relink it from the Media page</div>}
        </div>
      </div>
      <Transport compact={compact} guides={guides} setGuides={setGuides} />
    </div>
  );
}

/** Drag the selected clip's picture around the program monitor (position), Shift-drag for scale. */
function TransformOverlay({ w, h }: { w: number; h: number }) {
  const p = useProject(s => s.project);
  const selection = useProject(s => s.selection);
  const frame = usePlayer(s => s.frame);
  const c = p.clips.find(x => selection.includes(x.id) && p.tracks.find(t => t.id === x.trackId)?.kind === 'video' && frame >= x.start && frame < clipEnd(x));
  if (!c || !w) return null;
  const m = p.media.find(x => x.id === c.mediaId);
  const sw = m?.width ?? p.settings.width, sh = m?.height ?? p.settings.height;
  const pl = placement(p, c, sw, sh);
  const k = w / p.settings.width;
  const start = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const base = P(), x0 = e.clientX, y0 = e.clientY, t0 = { ...c.transform }, key = `xf:${Date.now()}`;
    const move = (ev: PointerEvent) => {
      useProject.getState().editFrom(base, ev.shiftKey ? 'Scale' : 'Position', q => {
        const x = q.clips.find(z => z.id === c.id)!;
        if (ev.shiftKey) x.transform.scale = Math.max(0.05, t0.scale * Math.pow(2, (ev.clientX - x0) / 200));
        else { x.transform.x = Math.round(t0.x + (ev.clientX - x0) / k); x.transform.y = Math.round(t0.y + (ev.clientY - y0) / k); }
      }, key);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="xf-box" title="Drag to position · Shift-drag to scale" onPointerDown={start}
      style={{ left: (pl.cx - pl.w / 2) * k, top: (pl.cy - pl.h / 2) * k, width: pl.w * k, height: pl.h * k, transform: `rotate(${pl.rotation}deg)` }}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
    </div>
  );
}

function Transport({ compact, guides, setGuides }: { compact?: boolean; guides: boolean; setGuides(v: boolean): void }) {
  const frame = usePlayer(s => s.frame);
  const playing = usePlayer(s => s.playing);
  const rate = usePlayer(s => s.rate);
  const loop = usePlayer(s => s.loop);
  const p = useProject(s => s.project);
  const fps = p.settings.fps;
  const dur = projectDuration(p);
  const still = async () => {
    try {
      const png = await getEngine().snapshotPng();
      const f = await api.saveStill(png, `${p.name}-${timecode(frame, fps).replace(/:/g, '-')}.png`);
      if (f) toast({ kind: 'success', title: 'Frame exported', body: f, action: { label: 'Show in folder', run: () => api.showInFolder(f) } });
    } catch (e: any) { toast({ kind: 'error', title: "Couldn't export the frame", body: String(e?.message ?? e) }); }
  };
  return (
    <div className="transport">
      <span className="tc big" data-testid="program-tc">{timecode(frame, fps)}</span>
      <span className="grow" />
      {!compact && <button className="icon-btn" title="Mark in (I)" onClick={() => A.setInOut('in')}><span className="io">{'{'}</span></button>}
      <button className="icon-btn" title="Go to start (Home)" onClick={() => { usePlayer.getState().pause(); usePlayer.getState().setFrame(0); }}><SkipBack size={15} /></button>
      <button className="icon-btn" title="Previous frame (←)" onClick={() => A.step(-1)}><StepBack size={15} /></button>
      <button className="icon-btn play" title="Play / pause (Space)" onClick={A.togglePlay} data-testid="play">{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <button className="icon-btn" title="Next frame (→)" onClick={() => A.step(1)}><StepForward size={15} /></button>
      <button className="icon-btn" title="Go to end (End)" onClick={() => { usePlayer.getState().pause(); usePlayer.getState().setFrame(Math.max(0, dur - 1)); }}><SkipForward size={15} /></button>
      {!compact && <button className="icon-btn" title="Mark out (O)" onClick={() => A.setInOut('out')}><span className="io">{'}'}</span></button>}
      <span className="grow" />
      {playing && rate !== 1 && <span className="rate">{rate > 0 ? '▶' : '◀'} {Math.abs(rate)}×</span>}
      <button className={`icon-btn${loop ? ' active' : ''}`} aria-pressed={loop} title="Loop in/out range" onClick={() => usePlayer.getState().setLoop(!loop)}><Repeat size={14} /></button>
      {!compact && <button className={`icon-btn${guides ? ' active' : ''}`} aria-pressed={guides} title="Safe-area guides" onClick={() => setGuides(!guides)}><Grid3x3 size={14} /></button>}
      <button className="icon-btn" title="Export this frame as PNG" onClick={still}><Camera size={14} /></button>
      <span className="tc dim">{timecode(dur, fps)}</span>
    </div>
  );
}

/* --------------------------------------------------------------- source */

export function SourceMonitor() {
  const id = usePlayer(s => s.sourceId);
  const m = useProject(s => s.project.media.find(x => x.id === id));
  const active = useUI(s => s.activeMonitor === 'source');
  return (
    <div className={`monitor source${active ? ' active' : ''}`} onPointerDown={() => useUI.getState().setActiveMonitor('source')}>
      <div className="monitor-head"><span className="mon-title">Source</span><span className="dim nm">{m?.name ?? 'No clip'}</span></div>
      {m ? <SourceView key={m.id} m={m} /> : <div className="monitor-view"><div className="mon-empty">Double-click a clip in the media bin to view it here, mark in <span className="kbd">I</span> and out <span className="kbd">O</span>, then insert <span className="kbd">,</span> or overwrite <span className="kbd">.</span></div></div>}
    </div>
  );
}

/** Imperative handle so keyboard shortcuts can drive whichever source monitor is mounted. */
export const sourceCtl: { toggle?(): void; step?(n: number): void; shuttle?(d: -1 | 0 | 1): void } = {};

function SourceView({ m }: { m: MediaItem }) {
  const p = useProject(s => s.project);
  const fps = m.fps || p.settings.fps;
  const ar = m.width && m.height ? m.width / m.height : 16 / 9;
  const { ref, size } = useFit(m.kind === 'audio' ? 3 : ar);
  const vid = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const time = usePlayer(s => s.sourceTime);
  const playing = usePlayer(s => s.sourcePlaying);
  const inP = usePlayer(s => s.sourceIn), outP = usePlayer(s => s.sourceOut);
  const dur = m.kind === 'image' ? 5 : m.duration;
  const set = (patch: Partial<ReturnType<typeof usePlayer.getState>>) => usePlayer.setState(patch);

  useEffect(() => {
    const el = vid.current;
    if (!el) return;
    let raf = 0;
    const tick = () => { set({ sourceTime: el.currentTime }); if (!el.paused) raf = requestAnimationFrame(tick); };
    const onPlay = () => { set({ sourcePlaying: true }); raf = requestAnimationFrame(tick); };
    const onPause = () => { set({ sourcePlaying: false, sourceTime: el.currentTime }); cancelAnimationFrame(raf); };
    el.addEventListener('play', onPlay); el.addEventListener('pause', onPause); el.addEventListener('seeked', tick);
    return () => { cancelAnimationFrame(raf); el.removeEventListener('play', onPlay); el.removeEventListener('pause', onPause); el.removeEventListener('seeked', tick); el.pause(); };
  }, [m.id]);

  const seek = (t: number) => { const el = vid.current; const v = Math.max(0, Math.min(dur, t)); if (el) el.currentTime = v; set({ sourceTime: v }); };
  const toggle = () => { const el = vid.current; if (!el) return; if (el.paused) { if (outP != null && el.currentTime >= outP - 0.01) el.currentTime = inP ?? 0; void el.play(); } else el.pause(); };
  sourceCtl.toggle = toggle;
  sourceCtl.step = n => { vid.current?.pause(); seek(time + n / fps); };
  sourceCtl.shuttle = d => { const el = vid.current; if (!el) return; if (d === 0) { el.pause(); el.playbackRate = 1; return; } if (d > 0) { el.playbackRate = el.paused ? 1 : Math.min(8, el.playbackRate * 2); void el.play(); } else { el.pause(); seek(time - 1); } };

  // Stop at the out point
  useEffect(() => { const el = vid.current; if (el && playing && outP != null && time >= outP) { el.pause(); seek(outP); } }, [time, playing, outP]);

  const bar = useRef<HTMLDivElement>(null);
  const scrub = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    const go = (x: number) => seek(((x - r.left) / r.width) * dur);
    go(e.clientX);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const dragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MEDIA_DND, JSON.stringify({ mediaId: m.id, srcIn: inP ?? 0, srcOut: outP ?? undefined }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const poster = m.thumbs ? cacheUrl(m.thumbs.key) : undefined;
  const src = m.kind === 'image' ? fileUrl(m.path) : mediaUrl(m);

  return (
    <>
      <div className="monitor-view" ref={ref}>
        <div className="monitor-frame src" style={{ width: size.w, height: size.h }}>
          {m.missing ? <div className="mon-msg">Media offline</div>
            : m.kind === 'image' ? <img src={src} alt="" />
              : m.kind === 'audio' ? <><audio ref={vid} src={src} preload="auto" /><SourceWave m={m} time={time} /></>
                : <video ref={vid} src={src} preload="auto" poster={poster && undefined} playsInline />}
          {m.proxy && <span className="mon-badge">Proxy</span>}
        </div>
      </div>
      <div className="src-bar" ref={bar} onPointerDown={scrub}>
        {(inP != null || outP != null) && <div className="src-range" style={{ left: `${((inP ?? 0) / dur) * 100}%`, width: `${(((outP ?? dur) - (inP ?? 0)) / dur) * 100}%` }} />}
        <div className="src-head" style={{ left: `${(time / dur) * 100}%` }} />
      </div>
      <div className="transport">
        <span className="tc big">{timecode(Math.round(time * fps), fps)}</span>
        <span className="grow" />
        <button className="icon-btn" title="Mark in (I)" onClick={() => set({ sourceIn: time, sourceOut: outP != null && outP <= time ? null : outP })}><span className="io">{'{'}</span></button>
        <button className="icon-btn" title="Previous frame" onClick={() => sourceCtl.step?.(-1)} disabled={m.kind === 'image'}><StepBack size={15} /></button>
        <button className="icon-btn play" title="Play / pause" onClick={toggle} disabled={m.kind === 'image'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
        <button className="icon-btn" title="Next frame" onClick={() => sourceCtl.step?.(1)} disabled={m.kind === 'image'}><StepForward size={15} /></button>
        <button className="icon-btn" title="Mark out (O)" onClick={() => set({ sourceOut: time, sourceIn: inP != null && inP >= time ? null : inP })}><span className="io">{'}'}</span></button>
        <span className="grow" />
        <span className="drag-src" draggable onDragStart={dragStart} title="Drag to the timeline"><GripVertical size={14} />Drag</span>
        <button className="btn sm" title="Insert at the playhead (,)" onClick={() => A.editFromSource('insert')}><CornerDownRight size={13} />Insert</button>
        <button className="btn sm" title="Overwrite at the playhead (.)" onClick={() => A.editFromSource('overwrite')}><ArrowDownToLine size={13} />Overwrite</button>
        <span className="tc dim" title="Marked duration">{timecode(Math.round(((outP ?? dur) - (inP ?? 0)) * fps), fps)}</span>
      </div>
    </>
  );
}

function SourceWave({ m, time }: { m: MediaItem; time: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Uint8Array | null>(null);
  useEffect(() => { if (m.waveform) fetch(cacheUrl(m.waveform.key)).then(r => r.arrayBuffer()).then(b => setPeaks(new Uint8Array(b))).catch(() => {}); }, [m.waveform?.key]);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = c.clientWidth * devicePixelRatio, h = c.clientHeight * devicePixelRatio;
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const per = peaks.length / w;
    for (let x = 0; x < w; x++) {
      let pk = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) pk = Math.max(pk, peaks[i]);
      const a = (pk / 255) * h * 0.46;
      g.fillStyle = x / w < time / m.duration ? '#e3a95c' : 'rgba(160,230,190,0.85)';
      g.fillRect(x, h / 2 - a, 1, Math.max(1, a * 2));
    }
  }, [peaks, time, m.duration]);
  return <canvas ref={ref} className="src-wave" />;
}
