/** Media page: a large bin with metadata, and the source monitor for marking selects. */
import React from 'react';
import { useProject } from '../store/project';
import { MediaBin } from '../components/MediaBin';
import { SourceMonitor } from '../components/Monitors';
import { Section } from '../components/ui';
import { api } from '../api';
import { relink } from '../services/media';

export function MediaPage() {
  const m = useProject(s => s.project.media.find(x => x.id === s.selectedMediaId));
  const uses = useProject(s => s.project.clips.filter(c => c.mediaId === s.selectedMediaId).length);
  return (
    <div className="page media-page">
      <div className="media-main"><MediaBin /></div>
      <div className="media-side">
        <SourceMonitor />
        <div className="panel-scroll media-meta">
          {m ? (
            <Section id="m-info" title="Clip info">
              <dl className="kv">
                <dt>Name</dt><dd>{m.name}</dd>
                <dt>Path</dt><dd title={m.path}>{m.path}</dd>
                <dt>Kind</dt><dd>{m.kind}</dd>
                {m.kind !== 'audio' && <><dt>Frame size</dt><dd>{m.width}×{m.height}{m.rotation ? ` (rotated ${m.rotation}°)` : ''}</dd></>}
                {m.kind === 'video' && <><dt>Frame rate</dt><dd>{+m.fps.toFixed(3)} fps</dd><dt>Video codec</dt><dd>{m.videoCodec}</dd><dt>Color space</dt><dd>{m.colorSpace ?? 'unspecified (Rec.709 assumed)'}</dd></>}
                {m.kind !== 'image' && <><dt>Duration</dt><dd>{m.duration.toFixed(2)} s</dd></>}
                {m.hasAudio && <><dt>Audio</dt><dd>{m.audioCodec} · {m.channels} ch · {m.sampleRate} Hz</dd></>}
                <dt>Size</dt><dd>{(m.size / 1e6).toFixed(1)} MB</dd>
                <dt>Preview</dt><dd>{m.proxy ? 'Proxy (720p H.264); export uses the original' : 'Original file'}</dd>
                <dt>Timeline uses</dt><dd>{uses}</dd>
              </dl>
              <div className="btn-row mt12">
                {m.missing ? <button className="btn sm" onClick={() => relink(m)}>Relink…</button> : <button className="btn sm" onClick={() => api.reveal(m.path)}>Show in folder</button>}
              </div>
            </Section>
          ) : <p className="dim small" style={{ padding: 14 }}>Select a clip to see its details.</p>}
        </div>
      </div>
    </div>
  );
}
