import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight, Check, Link2, Link2Off } from 'lucide-react';
import { useLibrary } from '../store/library';
import { SidePanel } from '../components/Panel';
import { Section, Seg, Stars, FlagMark, Empty } from '../components/ui';
import { Thumb } from '../components/Thumb';
import { setRating, setFlag } from '../services/actions';
import { api, media } from '../api';
import { offscreen, prepare, contextFor, loadMaskAssets } from '../services/offscreen';
import { computeGeometry } from '../engine/geometry';
import { encodeJpeg } from '../engine/host';
import { normalizeEdit, defaultEdit, type EditParams } from '@shared/edit';
import type { Photo, Snapshot, HistoryEntry } from '@shared/types';
import { formatExposure } from '../library/format';

type View = { zoom: number; cx: number; cy: number };

/** Side-by-side comparison: two photos (select vs candidate) or two versions of one photo. Zoom and pan are linked. */
export function CompareWorkspace() {
  const photos = useLibrary(s => s.photos);
  const activeId = useLibrary(s => s.activeId);
  const selection = useLibrary(s => s.selection);
  const [mode, setMode] = useState<'photos' | 'versions'>('photos');
  const [candidateId, setCandidateId] = useState<number | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [linked, setLinked] = useState(true);
  const [view2, setView2] = useState<View>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const select = photos.find(p => p.id === activeId) ?? photos[0];

  useEffect(() => {
    if (!select) return;
    const other = selection.find(id => id !== select.id);
    if (other != null) setCandidateId(other);
    else if (candidateId == null || candidateId === select.id) {
      const i = photos.findIndex(p => p.id === select.id);
      setCandidateId(photos[i + 1]?.id ?? photos[i - 1]?.id ?? null);
    }
  }, [select?.id]);

  if (!select) return <div className="center"><Empty kind="compare" title="Nothing to compare"><p>Import photos first, then select two to compare.</p></Empty></div>;
  const candidate = photos.find(p => p.id === candidateId) ?? null;
  const moveCandidate = (d: number) => {
    const i = photos.findIndex(p => p.id === candidateId);
    let j = i + d;
    if (photos[j]?.id === select.id) j += d;
    if (photos[j]) setCandidateId(photos[j].id);
  };

  return (
    <>
      <div className="center">
        <div className="lib-toolbar">
          <Seg value={mode} onChange={setMode} options={[{ value: 'photos', label: 'Two photos' }, { value: 'versions', label: 'Edit versions' }]} />
          <button className={`icon-btn${linked ? ' active' : ''}`} onClick={() => setLinked(!linked)} title={linked ? 'Zoom & pan linked' : 'Zoom & pan independent'}>{linked ? <Link2 size={15} /> : <Link2Off size={15} />}</button>
          <span className="muted small">Scroll to zoom, drag to pan, double-click to fit</span>
          <div className="grow" />
          {mode === 'photos' && <>
            <button className="btn sm" onClick={() => moveCandidate(-1)}><ChevronLeft size={13} />Prev candidate</button>
            <button className="btn sm" onClick={() => moveCandidate(1)}>Next candidate<ChevronRight size={13} /></button>
            <button className="btn sm" disabled={!candidate} onClick={() => { if (candidate) { useLibrary.getState().setActive(candidate.id); setCandidateId(select.id); } }}><ArrowLeftRight size={13} />Swap</button>
          </>}
        </div>
        {mode === 'photos' ? (
          <div className="compare-grid">
            <ComparePane title="Select" photo={select} url={media.preview(select.id, `${useLibrary.getState().thumbVersions[select.id] ?? 0}-${select.editedAt}`)} view={view} setView={v => { setView(v); if (linked) setView2(v); }} />
            {candidate ? <ComparePane title="Candidate" photo={candidate} url={media.preview(candidate.id, `${useLibrary.getState().thumbVersions[candidate.id] ?? 0}-${candidate.editedAt}`)} view={linked ? view : view2} setView={v => { if (linked) setView(v); setView2(v); }}
              footer={<button className="btn sm" onClick={() => { useLibrary.getState().setActive(candidate.id); }}><Check size={12} />Make select</button>} /> : <Empty kind="compare" title="No candidate" small />}
          </div>
        ) : <VersionsCompare photo={select} view={view} setView={setView} />}
      </div>
      <SidePanel side="right">
        <Section id="cmp.pick" title="Candidates">
          <div className="cmp-strip">
            {photos.slice(0, 400).map(p => (
              <div key={p.id} className={`film-cell${p.id === select.id ? ' active' : p.id === candidateId ? ' selected' : ''}`} onClick={() => (p.id === select.id ? null : setCandidateId(p.id))} title={p.filename}>
                <Thumb photo={p} />
              </div>
            ))}
          </div>
        </Section>
      </SidePanel>
    </>
  );
}

function ComparePane({ title, photo, url, view, setView, footer }: { title: string; photo: Photo; url: string; view: View; setView(v: View): void; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const wheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const z = Math.max(1, Math.min(12, view.zoom * Math.exp(-e.deltaY * 0.002)));
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    // keep the point under the cursor fixed
    const ux = view.cx + (px - 0.5) / view.zoom, uy = view.cy + (py - 0.5) / view.zoom;
    setView({ zoom: z, cx: clamp(ux - (px - 0.5) / z, z), cy: clamp(uy - (py - 0.5) / z, z) });
  };
  const down = (e: React.PointerEvent) => {
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, v0 = view;
    const r = el.getBoundingClientRect();
    const mv = (ev: PointerEvent) => setView({ ...v0, cx: clamp(v0.cx - (ev.clientX - x0) / r.width / v0.zoom, v0.zoom), cy: clamp(v0.cy - (ev.clientY - y0) / r.height / v0.zoom, v0.zoom) });
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  return (
    <div className="compare-pane">
      <div className="compare-head"><span className="tag">{title}</span><span className="text-0">{photo.filename}</span><FlagMark flag={photo.flag} /><span className="grow" /><Stars value={photo.rating} onChange={v => setRating(v, [photo.id])} /></div>
      <div className="compare-img" ref={ref} onWheel={wheel} onPointerDown={down} onDoubleClick={() => setView({ zoom: 1, cx: 0.5, cy: 0.5 })}>
        <img src={url} alt={photo.filename} draggable={false} style={{ transform: `scale(${view.zoom}) translate(${(0.5 - view.cx) * 100}%, ${(0.5 - view.cy) * 100}%)` }} />
      </div>
      <div className="compare-foot"><span className="dim small">{formatExposure(photo.exif)}</span><span className="grow" />
        <button className="btn sm ghost" onClick={() => setFlag(photo.flag === 'pick' ? 'none' : 'pick', [photo.id])}>{photo.flag === 'pick' ? 'Unpick' : 'Pick'}</button>
        <button className="btn sm ghost" onClick={() => setFlag(photo.flag === 'reject' ? 'none' : 'reject', [photo.id])}>{photo.flag === 'reject' ? 'Unreject' : 'Reject'}</button>
        {footer}
      </div>
    </div>
  );
}
const clamp = (c: number, z: number) => Math.min(1 - 0.5 / z, Math.max(0.5 / z, c));

/* --------------------------------------------------------------- versions */

export async function renderVersion(photo: Photo, e: EditParams): Promise<string> {
  return offscreen(async r => {
    const src = await prepare(r, photo, 'preview', 2048);
    const edit = normalizeEdit(e, photo.isRaw);
    if (edit.wb.mode === 'asShot') edit.wb = { mode: 'asShot', temp: src.asShot.temp, tint: src.asShot.tint };
    const rc = contextFor(photo, edit, src.width, src.height, await loadMaskAssets(edit, photo.id));
    const g = computeGeometry(edit, src.width, src.height, rc.lens);
    const out = r.render(edit, rc, { scale: Math.min(1, 1800 / Math.max(g.outW, g.outH)) }, 'version');
    const jpg = await encodeJpeg(r.readEncoded(out, 'srgb', 8) as Uint8Array, out.width, out.height, 0.9);
    return URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
  });
}

function VersionsCompare({ photo, view, setView }: { photo: Photo; view: View; setView(v: View): void }) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const [left, setLeft] = useState('original');
  const [right, setRight] = useState('current');
  const [urls, setUrls] = useState<[string | null, string | null]>([null, null]);
  useEffect(() => { api.snapshots(photo.id).then(setSnaps); api.history(photo.id).then(setHist); }, [photo.id]);
  const editFor = async (k: string): Promise<EditParams> => {
    if (k === 'original') { const d = defaultEdit(photo.isRaw); const cur = normalizeEdit(await api.getEdit(photo.id), photo.isRaw); d.crop = cur.crop; return d; }
    if (k === 'current') return normalizeEdit(await api.getEdit(photo.id), photo.isRaw);
    if (k.startsWith('s')) return snaps.find(s => `s${s.id}` === k)!.edit;
    return hist.find(h => `h${h.id}` === k)!.edit;
  };
  useEffect(() => {
    let alive = true;
    setUrls([null, null]);
    (async () => {
      const a = await renderVersion(photo, await editFor(left));
      const b = await renderVersion(photo, await editFor(right));
      if (alive) setUrls([a, b]);
    })().catch(console.error);
    return () => { alive = false; };
  }, [photo.id, left, right, snaps.length, hist.length]);
  const opts = (
    <>
      <option value="original">Original (no edits)</option>
      <option value="current">Current edit</option>
      {snaps.length > 0 && <optgroup label="Snapshots">{snaps.map(s => <option key={s.id} value={`s${s.id}`}>{s.name}</option>)}</optgroup>}
      {hist.length > 0 && <optgroup label="History">{[...hist].reverse().slice(0, 60).map(h => <option key={h.id} value={`h${h.id}`}>{h.label}</option>)}</optgroup>}
    </>
  );
  const pane = (k: string, set: (v: string) => void, url: string | null) => (
    <div className="compare-pane">
      <div className="compare-head"><select className="input sm" value={k} onChange={e => set(e.target.value)}>{opts}</select></div>
      <VersionImg url={url} view={view} setView={setView} />
    </div>
  );
  return <div className="compare-grid">{pane(left, setLeft, urls[0])}{pane(right, setRight, urls[1])}</div>;
}

function VersionImg({ url, view, setView }: { url: string | null; view: View; setView(v: View): void }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!url) return <div className="compare-img"><div className="viewer-loading"><div className="spinner" /></div></div>;
  return (
    <div className="compare-img" ref={ref} onDoubleClick={() => setView({ zoom: 1, cx: 0.5, cy: 0.5 })}
      onWheel={e => { const z = Math.max(1, Math.min(12, view.zoom * Math.exp(-e.deltaY * 0.002))); setView({ ...view, zoom: z, cx: clamp(view.cx, z), cy: clamp(view.cy, z) }); }}
      onPointerDown={e => {
        const el = ref.current!; el.setPointerCapture(e.pointerId);
        const x0 = e.clientX, y0 = e.clientY, v0 = view, r = el.getBoundingClientRect();
        const mv = (ev: PointerEvent) => setView({ ...v0, cx: clamp(v0.cx - (ev.clientX - x0) / r.width / v0.zoom, v0.zoom), cy: clamp(v0.cy - (ev.clientY - y0) / r.height / v0.zoom, v0.zoom) });
        const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
      }}>
      <img src={url} alt="" draggable={false} style={{ transform: `scale(${view.zoom}) translate(${(0.5 - view.cx) * 100}%, ${(0.5 - view.cy) * 100}%)` }} />
    </div>
  );
}
