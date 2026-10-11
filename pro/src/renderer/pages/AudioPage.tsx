/** Audio page: mixer with faders, balance, mute/solo and live meters, above the timeline. */
import React, { useEffect, useRef } from 'react';
import { type Track } from '@shared/project';
import { useProject } from '../store/project';
import { getEngine } from '../player/engine';
import { ProgramMonitor } from '../components/Monitors';
import { Timeline } from '../timeline/Timeline';

const toDb = (g: number) => (g <= 1e-5 ? -100 : 20 * Math.log10(g));
const meterPos = (db: number) => Math.max(0, Math.min(1, (db + 60) / 66)); // −60…+6 dBFS

/** Fader position 0..1 ↔ dB (−60 = off … +12), with more resolution near 0 dB. */
const faderToDb = (x: number) => (x <= 0 ? -60 : x < 0.75 ? -60 + (x / 0.75) ** 0.5 * 60 : ((x - 0.75) / 0.25) * 12);
const dbToFader = (db: number) => (db <= -60 ? 0 : db <= 0 ? 0.75 * ((db + 60) / 60) ** 2 : 0.75 + (db / 12) * 0.25);

function Meter({ id }: { id: string | 'master' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const hold = [0, 0], held = [0, 0];
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current;
      if (!c) return;
      const m = getEngine().meters();
      const v = id === 'master' ? m.master : m.tracks[id] ?? [0, 0];
      const W = c.width = c.clientWidth * devicePixelRatio, H = c.height = c.clientHeight * devicePixelRatio;
      const g = c.getContext('2d')!;
      g.fillStyle = '#0b0c0e'; g.fillRect(0, 0, W, H);
      const bw = (W - 3) / 2;
      v.forEach((lin, i) => {
        const db = toDb(lin), pos = meterPos(db);
        if (pos >= hold[i]) { hold[i] = pos; held[i] = performance.now(); } else if (performance.now() - held[i] > 900) hold[i] = Math.max(pos, hold[i] - 0.01);
        const x = 1 + i * (bw + 1);
        const grad = g.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, '#3fbf74'); grad.addColorStop(meterPos(-12), '#3fbf74'); grad.addColorStop(meterPos(-6), '#e8c547'); grad.addColorStop(meterPos(0), '#ff5c5c'); grad.addColorStop(1, '#ff5c5c');
        g.fillStyle = grad;
        g.fillRect(x, H - pos * H, bw, pos * H);
        g.fillStyle = hold[i] >= meterPos(0) ? '#ff5c5c' : 'rgba(255,255,255,0.7)';
        g.fillRect(x, H - hold[i] * H, bw, 2 * devicePixelRatio);
      });
      g.fillStyle = 'rgba(255,255,255,0.18)';
      for (const db of [0, -6, -12, -24, -48]) g.fillRect(0, H - meterPos(db) * H, W, 1);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [id]);
  return <canvas className="meter" ref={ref} data-testid={`meter-${id}`} />;
}

function Fader({ db, onChange }: { db: number; onChange(db: number, done?: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent) => {
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const at = (y: number) => Math.round(faderToDb(1 - (y - r.top) / r.height) * 10) / 10;
    onChange(at(e.clientY));
    const move = (ev: PointerEvent) => onChange(at(ev.clientY));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <div className="fader" ref={ref} onPointerDown={start} onDoubleClick={() => onChange(0, true)} role="slider" aria-label="Volume" aria-valuemin={-60} aria-valuemax={12} aria-valuenow={db} tabIndex={0}
      onKeyDown={e => { if (e.key === 'ArrowUp') onChange(Math.min(12, db + 0.5)); if (e.key === 'ArrowDown') onChange(Math.max(-60, db - 0.5)); }}>
      <div className="fader-track" />
      {[12, 6, 0, -6, -12, -24, -40].map(d => <span key={d} className="fader-mark" style={{ bottom: `${dbToFader(d) * 100}%` }}>{d > 0 ? `+${d}` : d}</span>)}
      <div className="fader-cap" style={{ bottom: `calc(${dbToFader(db) * 100}% - 9px)` }} />
    </div>
  );
}

function Strip({ t }: { t: Track }) {
  const edit = useProject(s => s.edit);
  const set = (label: string, patch: Partial<Track>, key?: string) => edit(label, p => Object.assign(p.tracks.find(x => x.id === t.id)!, patch), key ? `${key}:${t.id}` : undefined);
  return (
    <div className="strip" data-testid={`strip-${t.name}`}>
      <div className="strip-name">{t.name}</div>
      <div className="strip-pan">
        <input type="range" min={-1} max={1} step={0.01} value={t.pan} onChange={e => set('Balance', { pan: Number(e.target.value) }, 'pan')} onDoubleClick={() => set('Balance', { pan: 0 })} aria-label={`${t.name} balance`} />
        <span className="dim small">{t.pan === 0 ? 'C' : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}</span>
      </div>
      <div className="strip-body">
        <Fader db={t.volume} onChange={(v, done) => set('Track volume', { volume: v }, done ? undefined : 'vol')} />
        <Meter id={t.id} />
      </div>
      <div className="strip-db">{t.volume <= -60 ? '−∞' : `${t.volume > 0 ? '+' : ''}${t.volume.toFixed(1)}`} dB</div>
      <div className="strip-btns">
        <button className={`btn sm${t.muted ? ' active mute' : ''}`} aria-pressed={t.muted} onClick={() => set(t.muted ? 'Unmute' : 'Mute', { muted: !t.muted })}>M</button>
        <button className={`btn sm${t.solo ? ' active solo' : ''}`} aria-pressed={t.solo} onClick={() => set(t.solo ? 'Unsolo' : 'Solo', { solo: !t.solo })}>S</button>
      </div>
    </div>
  );
}

export function AudioPage() {
  const all = useProject(s => s.project.tracks);
  const tracks = all.filter(t => t.kind === 'audio');
  return (
    <div className="page audio-page">
      <div className="audio-top">
        <div className="mixer" data-testid="mixer">
          <div className="panel-title">Mixer <span className="dim small">· the same mix is rendered on export</span></div>
          <div className="strips">
            {tracks.map(t => <Strip key={t.id} t={t} />)}
            <div className="strip master">
              <div className="strip-name">Master</div>
              <div className="strip-pan" />
              <div className="strip-body"><Meter id="master" /></div>
              <div className="strip-db dim">dBFS</div>
              <div className="strip-btns" />
            </div>
          </div>
        </div>
        <ProgramMonitor compact showTransform={false} />
      </div>
      <Timeline />
    </div>
  );
}

