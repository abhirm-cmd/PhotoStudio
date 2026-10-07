import React, { useState } from 'react';
import { AlertTriangle, RotateCw, SkipForward, FileWarning } from 'lucide-react';
import type { Photo } from '@shared/types';
import { api, media } from '../api';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';

/** A catalog thumbnail with loading shimmer, cache-busting on re-render, and RAW failure handling. */
export function Thumb({ photo, size = 'thumb', className }: { photo: Photo; size?: 'thumb' | 'preview'; className?: string }) {
  const v = useLibrary(s => s.thumbVersions[photo.id] ?? 0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (photo.thumbState === 'pending') return <div className="thumb-pending skeleton" />;
  if (photo.thumbState === 'error') return <ThumbError photo={photo} />;
  const ver = `${v}-${photo.editedAt ?? ''}`;
  const src = size === 'thumb' ? media.thumb(photo.id, ver) : media.preview(photo.id, ver);
  if (failed) return <ThumbError photo={{ ...photo, error: 'The preview could not be loaded.' }} />;
  return <img className={`${className ?? ''}${loaded ? '' : ' loading'}`} src={src} alt={photo.filename} draggable={false} decoding="async" loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />;
}

export function ThumbError({ photo, large }: { photo: Photo; large?: boolean }) {
  const [busy, setBusy] = useState(false);
  const retry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    const p = await api.retryPreview(photo.id);
    if (p) useLibrary.getState().replacePhoto(p);
    setBusy(false);
  };
  const skip = (e: React.MouseEvent) => { e.stopPropagation(); useLibrary.getState().navigate(1); };
  const report = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const file = await api.reportIssue(photo.id);
    useApp.getState().toast({ kind: 'info', title: 'Report saved', body: `Nothing was sent anywhere. The report is at ${file}`, action: { label: 'Show file', run: () => api.revealPath(file) } });
  };
  return (
    <div className={`cell-error${large ? ' large' : ''}`} role="alert">
      {large ? <FileWarning size={34} /> : <AlertTriangle size={18} />}
      <div className="t">{photo.isRaw ? 'Unable to process this RAW file.' : 'Unable to open this image.'}</div>
      {large && <div className="muted small selectable">{photo.error}</div>}
      <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={retry} disabled={busy}><RotateCw size={12} />{busy ? 'Retrying…' : 'Retry'}</button>
        <button className="btn sm ghost" onClick={skip}><SkipForward size={12} />Skip</button>
        <button className="btn sm ghost" onClick={report}>Report</button>
      </div>
    </div>
  );
}
