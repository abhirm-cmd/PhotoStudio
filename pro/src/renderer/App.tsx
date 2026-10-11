import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, Save, FolderOpen, FilePlus, ChevronDown, Keyboard, FilePlus2 } from 'lucide-react';
import { useProject } from './store/project';
import { usePlayer } from './store/player';
import { useUI, type Page } from './store/ui';
import { api } from './api';
import { Toasts, MenuHost, PromptHost, Modal, openMenu, Kbd } from './components/ui';
import { MediaPage } from './pages/MediaPage';
import { EditPage } from './pages/EditPage';
import { ColorPage } from './color/ColorPage';
import { AudioPage } from './pages/AudioPage';
import { DeliverPage } from './pages/DeliverPage';
import { getEngine } from './player/engine';
import { importDialog, importPaths, enqueueAnalysis } from './services/media';
import { saveProject, openProject, newProjectFlow, recoverAutosave, startAutosave, setAskUnsaved, confirmDiscard } from './services/project';
import * as A from './services/actions';
import { clipsForMedia, placeClips } from '@shared/timeline';
import { setTl, tlPrefs, zoomBy } from './timeline/Timeline';
import { sourceCtl } from './components/Monitors';

const PAGES: { id: Page; label: string; key: string }[] = [
  { id: 'media', label: 'Media', key: '1' }, { id: 'edit', label: 'Edit', key: '2' }, { id: 'color', label: 'Color', key: '3' },
  { id: 'audio', label: 'Audio', key: '4' }, { id: 'deliver', label: 'Deliver', key: '5' },
];

export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], ['J / K / L', 'Shuttle reverse / stop / forward (press again to speed up)'], ['← / →', 'Previous / next frame'], ['Shift+← / →', 'Back / forward 1 second'],
  ['↑ / ↓', 'Previous / next edit point'], ['Home / End', 'Start / end of timeline'], ['I / O', 'Mark in / out (source or program)'], ['Alt+X', 'Clear in/out'],
  [', / .', 'Insert / overwrite from the source monitor'], ['V / C', 'Selection / razor tool'], ['S', 'Toggle snapping'], ['Mod+K', 'Split at the playhead'],
  ['Delete', 'Delete selected clips'], ['Shift+Delete', 'Ripple delete'], ['Alt+← / →', 'Nudge selected clips one frame'], ['Shift+E', 'Enable / disable clip'],
  ['Mod+D', 'Add cross dissolve to selected clip'], ['M', 'Add marker'], ['Mod+C / Mod+V', 'Copy / paste clips at the playhead'], ['Mod+A', 'Select all clips'],
  ['= / -', 'Zoom timeline in / out'], ['\\', 'Zoom timeline to fit'], ['Mod+Z / Mod+Shift+Z', 'Undo / redo'], ['Mod+S', 'Save project'], ['Mod+I', 'Import media'],
  ['1 – 5', 'Media, Edit, Color, Audio, Deliver pages'], ['Mod+/', 'This list'],
];

function TopBar() {
  const page = useUI(s => s.page);
  const setPage = useUI(s => s.setPage);
  const name = useProject(s => s.project.name);
  const dirty = useProject(s => s.dirty);
  const past = useProject(s => s.past.length);
  const future = useProject(s => s.future.length);
  const last = useProject(s => s.lastLabel);
  const tasks = useUI(s => s.tasks);
  const t = Object.values(tasks)[0];
  const fileMenu = async (e: React.MouseEvent) => {
    const recent = await api.recent().catch(() => [] as string[]);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      { label: 'New project', icon: <FilePlus size={13} />, shortcut: 'Mod+N', onClick: () => newProjectFlow() },
      { label: 'Open project…', icon: <FolderOpen size={13} />, shortcut: 'Mod+O', onClick: () => openProject() },
      ...recent.slice(0, 6).map(f => ({ label: `   ${f.split(/[\\/]/).pop()}`, onClick: () => openProject(f) })),
      { sep: true },
      { label: 'Save', icon: <Save size={13} />, shortcut: 'Mod+S', onClick: () => saveProject() },
      { label: 'Save as…', shortcut: 'Mod+Shift+S', onClick: () => saveProject(true) },
      { sep: true },
      { label: 'Import media…', icon: <FilePlus2 size={13} />, shortcut: 'Mod+I', onClick: () => importDialog('files') },
      { label: 'Keyboard shortcuts', icon: <Keyboard size={13} />, shortcut: 'Mod+/', onClick: () => useUI.getState().setShortcuts(true) },
    ]);
  };
  const mac = api.platform() === 'darwin';
  return (
    <header className={`topbar${mac ? ' mac' : ''}`}>
      <div className="brand"><div className="brand-mark pro" />PhotoStudio <span className="pro-tag">Pro</span></div>
      <button className="btn sm ghost proj-btn" onClick={fileMenu} title="Project menu"><span className="nm" data-testid="project-name">{name}</span>{dirty && <span className="dirty" title="Unsaved changes">●</span>}<ChevronDown size={12} /></button>
      <div className="topbar-spacer" />
      <nav className="workspaces" aria-label="Pages">
        {PAGES.map(p => <button key={p.id} className={`ws-tab${page === p.id ? ' active' : ''}`} onClick={() => setPage(p.id)} title={`${p.label} (${p.key})`} data-page={p.id}>{p.label}</button>)}
      </nav>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        {t && <div className="task-chip" title={t.label}><span className="nm">{t.label}</span>{t.progress != null ? <span className="dim">{Math.round(t.progress * 100)}%</span> : <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}</div>}
        <button className="icon-btn" disabled={!past} onClick={() => useProject.getState().undo()} title={`Undo${past ? ` ${useProject.getState().past[past - 1].label}` : ''} (Mod+Z)`}><Undo2 size={15} /></button>
        <button className="icon-btn" disabled={!future} onClick={() => useProject.getState().redo()} title={`Redo${future ? ` ${useProject.getState().future[0].label}` : ''} (Mod+Shift+Z)`}><Redo2 size={15} /></button>
        <span className="last-action dim small" title="Last change">{last}</span>
        <button className="btn sm" onClick={() => saveProject()} title="Save project (Mod+S)"><Save size={13} />Save</button>
      </div>
    </header>
  );
}

function UnsavedHost() {
  const [req, setReq] = useState<((a: 'save' | 'discard' | 'cancel') => void) | null>(null);
  useEffect(() => { setAskUnsaved(() => new Promise(res => setReq(() => res))); return () => setAskUnsaved(null); }, []);
  if (!req) return null;
  const done = (a: 'save' | 'discard' | 'cancel') => { req(a); setReq(null); };
  return (
    <Modal title="Save changes to this project?" onClose={() => done('cancel')} footer={<>
      <button className="btn danger" onClick={() => done('discard')}>Don’t save</button>
      <span className="grow" />
      <button className="btn ghost" onClick={() => done('cancel')}>Cancel</button>
      <button className="btn primary" onClick={() => done('save')} autoFocus>Save</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>“{useProject.getState().project.name}” has edits that haven’t been saved. If you don’t save, they’ll be lost.</p>
    </Modal>
  );
}

function ShortcutsModal() {
  const open = useUI(s => s.shortcuts);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => useUI.getState().setShortcuts(false)}>
      <div className="shortcut-grid">{SHORTCUTS.map(([k, d]) => <div key={k} className="sc"><span className="sc-keys">{k.split(' / ').map((x, i) => <React.Fragment key={x}>{i > 0 && ' / '}<Kbd combo={x} /></React.Fragment>)}</span><span>{d}</span></div>)}</div>
    </Modal>
  );
}

function RecoveryPrompt({ onDone }: { onDone(): void }) {
  return (
    <Modal title="Recover unsaved work?" onClose={() => { void api.clearAutosave(); onDone(); }} footer={<>
      <button className="btn ghost" onClick={() => { void api.clearAutosave(); onDone(); }}>Discard</button>
      <button className="btn primary" onClick={async () => { await recoverAutosave(); onDone(); }}>Recover</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>PhotoStudio Pro closed before your last changes were saved. An autosaved copy of the project is available.</p>
    </Modal>
  );
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('.modal-backdrop')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const src = useUI.getState().activeMonitor === 'source' && !!usePlayer.getState().sourceId;
      const page = useUI.getState().page;
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      if (!mod && !e.altKey && /^[1-5]$/.test(k)) { useUI.getState().setPage(PAGES[Number(k) - 1].id); return handled(); }
      if (mod && k.toLowerCase() === 'k') { A.splitAtPlayhead(e.shiftKey); return handled(); }
      if (mod && k.toLowerCase() === 'd') { A.setTransition('dissolve'); return handled(); }
      if (mod && k.toLowerCase() === 'c') { A.copySelection(); return handled(); }
      if (mod && k.toLowerCase() === 'v') { A.paste(); return handled(); }
      if (mod && k.toLowerCase() === 'a') { A.selectAll(); return handled(); }
      if (mod && k === '/') { useUI.getState().setShortcuts(true); return handled(); }
      if (mod) return;
      switch (k) {
        case ' ': if (src) sourceCtl.toggle?.(); else A.togglePlay(); return handled();
        case 'j': case 'J': if (src) sourceCtl.shuttle?.(-1); else A.shuttle(-1); return handled();
        case 'k': case 'K': if (src) sourceCtl.shuttle?.(0); else A.shuttle(0); return handled();
        case 'l': case 'L': if (src) sourceCtl.shuttle?.(1); else A.shuttle(1); return handled();
        case 'ArrowLeft': if (e.altKey) { if (A.nudge(-1)) return handled(); } if (src) sourceCtl.step?.(e.shiftKey ? -25 : -1); else A.step(e.shiftKey ? -Math.round(useProject.getState().project.settings.fps) : -1); return handled();
        case 'ArrowRight': if (e.altKey) { if (A.nudge(1)) return handled(); } if (src) sourceCtl.step?.(e.shiftKey ? 25 : 1); else A.step(e.shiftKey ? Math.round(useProject.getState().project.settings.fps) : 1); return handled();
        case 'ArrowUp': A.jumpEdit(-1); return handled();
        case 'ArrowDown': A.jumpEdit(1); return handled();
        case 'Home': usePlayer.getState().pause(); usePlayer.getState().setFrame(0); return handled();
        case 'End': usePlayer.getState().pause(); usePlayer.getState().setFrame(Math.max(0, useProject.getState().project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) - 1)); return handled();
        case 'i': case 'I':
          if (src) { const t = usePlayer.getState().sourceTime; const o = usePlayer.getState().sourceOut; usePlayer.setState({ sourceIn: t, sourceOut: o != null && o <= t ? null : o }); } else A.setInOut('in');
          return handled();
        case 'o': case 'O':
          if (src) { const t = usePlayer.getState().sourceTime; const i = usePlayer.getState().sourceIn; usePlayer.setState({ sourceOut: t, sourceIn: i != null && i >= t ? null : i }); } else A.setInOut('out');
          return handled();
        case 'x': case 'X': if (e.altKey) { if (src) usePlayer.setState({ sourceIn: null, sourceOut: null }); else A.setInOut('clear'); return handled(); } return;
        case ',': A.editFromSource('insert'); return handled();
        case '.': A.editFromSource('overwrite'); return handled();
        case 'v': case 'V': setTl({ tool: 'select' }); return handled();
        case 'c': case 'C': setTl({ tool: 'razor' }); return handled();
        case 's': case 'S': setTl({ snap: !tlPrefs.snap }); return handled();
        case 'm': case 'M': A.addMarker(); return handled();
        case 'E': if (e.shiftKey) { A.toggleEnabled(); return handled(); } return;
        case 'Delete': case 'Backspace': if (page === 'edit' || page === 'audio' || page === 'color') { A.deleteSelection(e.shiftKey); return handled(); } return;
        case '=': case '+': zoomBy(1.5); return handled();
        case '-': zoomBy(1 / 1.5); return handled();
        case '\\': document.querySelector<HTMLButtonElement>('button[title^="Zoom to fit"]')?.click(); return handled();
        case 'Escape': useProject.getState().select([]); return;
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
}

export function App() {
  const page = useUI(s => s.page);
  const [recovery, setRecovery] = useState(false);
  useShortcuts();

  useEffect(() => {
    getEngine();
    startAutosave();
    void api.recover().then(r => { if (r?.project && (r.project.clips?.length || r.project.media?.length)) setRecovery(true); });
    const offMenu = api.on('menu:action', (a: string) => {
      if (a === 'project.new') void newProjectFlow();
      else if (a === 'project.open') void openProject();
      else if (a === 'project.save') void saveProject();
      else if (a === 'project.saveAs') void saveProject(true);
      else if (a === 'media.import') void importDialog('files');
      else if (a === 'page.deliver') useUI.getState().setPage('deliver');
      else if (a === 'edit.undo') { if (!isTyping({ target: document.activeElement } as any)) useProject.getState().undo(); }
      else if (a === 'edit.redo') { if (!isTyping({ target: document.activeElement } as any)) useProject.getState().redo(); }
      else if (a === 'app.shortcuts') useUI.getState().setShortcuts(true);
    });
    const offClose = api.on('app:before-close', async () => {
      if (await confirmDiscard()) { await api.clearAutosave(); void api.close(); }
    });
    // Test hook (also handy from DevTools)
    (window as any).__psp = { useProject, usePlayer, useUI, engine: getEngine, api, actions: A, timeline: { clipsForMedia, placeClips }, importPaths, enqueueAnalysis, saveProject, openProject, setTl };
    return () => { offMenu(); offClose(); };
  }, []);

  // Window title: project name and unsaved marker
  const name = useProject(s => s.project.name);
  const dirty = useProject(s => s.dirty);
  useEffect(() => { void api.setTitle(`${dirty ? '● ' : ''}${name} — PhotoStudio Pro`); }, [name, dirty]);

  return (
    <div className="app">
      <TopBar />
      <main className="main">
        {page === 'media' && <MediaPage />}
        {page === 'edit' && <EditPage />}
        {page === 'color' && <ColorPage />}
        {page === 'audio' && <AudioPage />}
        {page === 'deliver' && <DeliverPage />}
      </main>
      <Toasts />
      <MenuHost />
      <PromptHost />
      <UnsavedHost />
      <ShortcutsModal />
      {recovery && <RecoveryPrompt onDone={() => setRecovery(false)} />}
    </div>
  );
}
