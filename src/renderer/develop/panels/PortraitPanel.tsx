import React, { useState } from 'react';
import { ScanFace, RefreshCw } from 'lucide-react';
import { useDevelop } from '../../store/develop';
import { useApp } from '../../store/app';
import { host } from '../../engine/host';
import { Section, Slider } from '../../components/ui';
import { generateMask, hasFaceDetector, NoResultError } from '../../analysis/segmentation';
import type { Portrait } from '@shared/edit';

type Kind = 'skin' | 'eyes' | 'teeth';
const NEEDS: Record<keyof Portrait, Kind> = { skinSmoothing: 'skin', skinTone: 'skin', skinEvenness: 'skin', faceLight: 'skin', eyeEnhance: 'eyes', teethWhitening: 'teeth' };

const pending = new Map<string, Promise<boolean>>();

/** Make sure the portrait layer for this photo exists, generating it on first use. */
async function ensureLayer(kind: Kind, force = false): Promise<boolean> {
  const id = useDevelop.getState().photoId;
  if (id == null) return false;
  const key = `ai:${id}:${kind}`;
  if (!force && host().assets.has(key)) return true;
  if (pending.has(key)) return pending.get(key)!;
  const p = (async () => {
    try {
      const r = await generateMask(kind, key);
      useApp.getState().toast({ kind: 'success', title: `${kind === 'skin' ? 'Skin' : kind === 'eyes' ? 'Eyes' : 'Teeth'} detected`, body: `${r.engine} · ${Math.round(r.ms)} ms` });
      return true;
    } catch (e: any) {
      useApp.getState().toast({ kind: e instanceof NoResultError ? 'info' : 'error', title: e?.message ?? 'Detection failed' });
      return false;
    } finally { pending.delete(key); }
  })();
  pending.set(key, p);
  return p;
}

export function PortraitPanel() {
  const portrait = useDevelop(s => s.edit.portrait);
  const photoId = useDevelop(s => s.photoId);
  const setEdit = useDevelop(s => s.setEdit);
  const [busy, setBusy] = useState<Kind | null>(null);
  const layers = (['skin', 'eyes', 'teeth'] as Kind[]).filter(k => photoId != null && host().assets.has(`ai:${photoId}:${k}`));
  const face = hasFaceDetector();

  const slider = (k: keyof Portrait, label: string, min = 0, title?: string) => {
    const kind = NEEDS[k];
    const unavailable = (kind === 'eyes' || kind === 'teeth') && !face;
    return (
      <Slider label={label} min={min} max={100} defaultValue={0} value={portrait[k]} title={unavailable ? 'Needs the system face detector (macOS, Windows, ChromeOS)' : title} disabled={unavailable || busy === kind}
        onChange={v => {
          setEdit(e => { e.portrait[k] = v; });
          if (v !== 0 && photoId != null && !host().assets.has(`ai:${photoId}:${kind}`) && !pending.has(`ai:${photoId}:${kind}`)) {
            setBusy(kind);
            ensureLayer(kind).then(ok => { setBusy(null); if (!ok) setEdit(e => { e.portrait[k] = 0; }); });
          }
        }}
        onCommit={() => useDevelop.getState().commit()} />
    );
  };

  return (
    <Section id="dev.portrait" title={<>Portrait <span className="tag local">On-device</span></>} defaultOpen={false}
      onReset={() => setEdit(e => { e.portrait = { skinSmoothing: 0, skinTone: 0, skinEvenness: 0, eyeEnhance: 0, teethWhitening: 0, faceLight: 0 }; }, 'Reset Portrait')}>
      {busy && <div className="row small muted mb8"><div className="spinner" />Detecting {busy}…</div>}
      {slider('skinSmoothing', 'Skin Smoothing', 0, 'Softens skin texture while keeping eyes, hair and edges sharp')}
      {slider('skinEvenness', 'Skin Evenness', 0, 'Unifies blotchy hue and saturation in skin')}
      <Slider label="Skin Tone" min={-100} max={100} defaultValue={0} value={portrait.skinTone} title="Cooler ← → warmer skin"
        onChange={v => { setEdit(e => { e.portrait.skinTone = v; }); if (v && photoId != null && !host().assets.has(`ai:${photoId}:skin`) && !pending.has(`ai:${photoId}:skin`)) { setBusy('skin'); ensureLayer('skin').then(() => setBusy(null)); } }}
        onCommit={() => useDevelop.getState().commit()} gradient="linear-gradient(90deg, #b9a6c8, #c9a089 50%, #e0a466)" />
      {slider('faceLight', 'Face Light', 0, 'Gently brightens faces')}
      {slider('eyeEnhance', 'Eye Enhance', 0, 'Brightens and adds clarity to eyes')}
      {slider('teethWhitening', 'Teeth Whitening')}
      <div className="row mt8">
        <span className="dim small grow">{layers.length ? `Detected: ${layers.join(', ')}` : 'Areas are detected when you first move a slider.'}</span>
        {layers.length > 0 && <button className="icon-btn sm" title="Detect again" onClick={async () => { for (const k of layers) { setBusy(k); await ensureLayer(k, true); } setBusy(null); }}><RefreshCw size={12} /></button>}
      </div>
      {!face && <p className="dim small"><ScanFace size={11} /> Eye and teeth tools use the system face detector, which isn't available on this platform. Skin tools work everywhere.</p>}
    </Section>
  );
}
