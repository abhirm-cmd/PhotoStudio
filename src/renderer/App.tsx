import React, { useEffect, useState } from 'react';
import { useApp } from './store/app';
import { useLibrary } from './store/library';
import { api } from './api';
import { startBackgroundServices } from './services/background';
import { installShortcuts, runAction } from './services/actions';
import { TopBar } from './components/TopBar';
import { Filmstrip } from './components/Filmstrip';
import { MenuHost, Toasts, PromptHost } from './components/ui';
import { LibraryWorkspace } from './workspaces/Library';
import { DevelopWorkspace } from './workspaces/Develop';
import { PresetsWorkspace } from './workspaces/Presets';
import { ExportWorkspace } from './workspaces/Export';
import { ReferenceWorkspace } from './workspaces/Reference';
import { CompareWorkspace } from './workspaces/Compare';
import { Modals } from './components/Modals';
import { isSupported } from '@shared/formats';

let booted = false;

export function App() {
  const workspace = useApp(s => s.workspace);
  const settings = useApp(s => s.settings);
  const filmstripOpen = useApp(s => s.filmstripOpen);
  const view = useLibrary(s => s.view);
  const [dragOver, setDragOver] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    if (booted) return;
    booted = true;
    (async () => {
      try {
        const s = await api.getSettings();
        useApp.getState().setSettings(s);
        useApp.setState({ platform: api.platform() });
        startBackgroundServices();
        installShortcuts();
        api.on('menu:action', (a: string) => runAction(a));
        await Promise.all([useLibrary.getState().refreshMeta(), useLibrary.getState().refresh()]);
        // End-to-end tests drive the real stores and services through this hook (test builds only).
        if ((await api.appInfo()).isTest) (window as any).__photostudio = await import('./services/testHooks').then(m => m.testHooks());
      } catch (e: any) {
        setFatal(String(e?.message ?? e));
      }
    })();
  }, []);

  // Drag files or folders anywhere onto the window to import them.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setDragOver(true); e.preventDefault(); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const paths = Array.from(e.dataTransfer!.files).map(f => api.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      // Reference-grade workspace takes dropped images as references instead of imports
      if (useApp.getState().workspace === 'reference' && paths.length === 1 && isSupported(paths[0])) {
        window.dispatchEvent(new CustomEvent('photostudio:reference-drop', { detail: paths[0] }));
        return;
      }
      useApp.getState().openModal('import', { paths });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, []);

  if (fatal) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <h3>PhotoStudio could not start</h3>
        <p className="muted">{fatal}</p>
        <button className="btn" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  if (!settings) return <div className="boot"><div className="brand-mark lg" /><div className="spinner" /></div>;

  const showFilmstrip = workspace !== 'export' && workspace !== 'presets' && !(workspace === 'library' && view === 'grid');

  return (
    <div className="app" data-workspace={workspace}>
      <TopBar />
      <div className="main">
        {workspace === 'library' && <LibraryWorkspace />}
        {(workspace === 'develop' || workspace === 'masking' || workspace === 'color') && <DevelopWorkspace mode={workspace} />}
        {workspace === 'presets' && <PresetsWorkspace />}
        {workspace === 'reference' && <ReferenceWorkspace />}
        {workspace === 'compare' && <CompareWorkspace />}
        {workspace === 'export' && <ExportWorkspace />}
      </div>
      {showFilmstrip && <Filmstrip hidden={!filmstripOpen} />}
      <Modals />
      <Toasts />
      <MenuHost />
      <PromptHost />
      {dragOver && <div className="drop-overlay fixed">{workspace === 'reference' ? 'Drop a reference image' : 'Drop to import photos'}</div>}
    </div>
  );
}
