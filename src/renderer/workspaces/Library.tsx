import React, { useState } from 'react';
import { Download, FolderInput, Sparkles } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { SidePanel } from '../components/Panel';
import { LibraryNav } from '../library/LibraryNav';
import { LibraryToolbar } from '../library/Toolbar';
import { Grid } from '../library/Grid';
import { Loupe, Survey } from '../library/Loupe';
import { InfoPanel } from '../library/InfoPanel';
import { Empty } from '../components/ui';
import { api } from '../api';

export function LibraryWorkspace() {
  const view = useLibrary(s => s.view);
  const photos = useLibrary(s => s.photos);
  const loading = useLibrary(s => s.loading);
  const stats = useLibrary(s => s.stats);
  const [showFilters, setShowFilters] = useState(false);
  const catalogEmpty = !loading && stats?.photos === 0;

  return (
    <>
      <SidePanel side="left"><LibraryNav /></SidePanel>
      <div className="center">
        {catalogEmpty ? <Welcome /> : (
          <>
            <LibraryToolbar showFilters={showFilters} setShowFilters={setShowFilters} />
            {!loading && !photos.length ? <NoResults /> : view === 'loupe' ? <Loupe /> : view === 'survey' ? <Survey /> : <Grid />}
          </>
        )}
      </div>
      <SidePanel side="right"><InfoPanel /></SidePanel>
    </>
  );
}

function NoResults() {
  const clear = useLibrary(s => s.clearFilter);
  const setSource = useLibrary(s => s.setSource);
  const source = useLibrary(s => s.source);
  return (
    <Empty kind="search" title="No photos match">
      <p>Try a different search, loosen the filters, or look in another folder.</p>
      <div className="btn-row">
        <button className="btn" onClick={clear}>Clear search & filters</button>
        {source.kind !== 'all' && <button className="btn ghost" onClick={() => setSource({ kind: 'all' })}>Show all photos</button>}
      </div>
    </Empty>
  );
}

function Welcome() {
  const open = useApp(s => s.openModal);
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <Empty kind="library" title="Welcome to Lumora Studio">
        <p>Import a folder of photos to start. Lumora reads RAW files from Canon, Nikon, Sony, Fujifilm, Olympus, Panasonic, Pentax and DNG, plus JPEG, PNG, TIFF, WebP and HEIC. Your originals are never modified.</p>
        <div className="dropzone mt12">
          <div className="col" style={{ alignItems: 'center', gap: 12 }}>
            <div className="muted">Drag photos or folders here, or</div>
            <div className="btn-row">
              <button className="btn primary lg" onClick={() => open('import')}><Download size={15} />Import Photos</button>
              <button className="btn lg" onClick={async () => { const paths = await api.pickImport('folder'); if (paths.length) open('import', { paths }); }}><FolderInput size={15} />Choose Folder</button>
            </div>
          </div>
        </div>
        <button className="btn ghost mt12" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await api.importDemo();
          if (!r) useApp.getState().toast({ kind: 'error', title: 'Demo photos are not available in this build' });
          setBusy(false);
        }}><Sparkles size={13} className="accent" />{busy ? 'Loading demo photos…' : 'Explore with demo photos'}</button>
      </Empty>
    </div>
  );
}
