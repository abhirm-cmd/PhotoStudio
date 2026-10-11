import React from 'react';
import { Download, Settings, Keyboard, X, Sparkles } from 'lucide-react';
import { useApp, type Workspace } from '../store/app';
import { goWorkspace } from '../services/actions';
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts';
import { Kbd, Progress } from './ui';

const TABS: { id: Workspace; label: string; star?: boolean }[] = [
  { id: 'library', label: 'Library' },
  { id: 'develop', label: 'Develop' },
  { id: 'masking', label: 'Masking' },
  { id: 'color', label: 'Color' },
  { id: 'presets', label: 'Presets' },
  { id: 'reference', label: 'Reference Grade', star: true },
  { id: 'compare', label: 'Compare' },
  { id: 'export', label: 'Export' },
];

export function TopBar() {
  const ws = useApp(s => s.workspace);
  const platform = useApp(s => s.platform);
  const tasks = useApp(s => s.tasks);
  const open = useApp(s => s.openModal);
  const shortcuts = useApp(s => s.settings?.shortcuts) ?? DEFAULT_SHORTCUTS;
  return (
    <header className={`topbar ${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : ''}`}>
      <div className="brand"><div className="brand-mark" />PhotoStudio <span className="dim brand-tagline" style={{ fontWeight: 500 }}>Alternative for Lightroom</span></div>
      <nav className="workspaces" aria-label="Workspaces">
        {TABS.map(t => (
          <button key={t.id} className={`ws-tab${ws === t.id ? ' active' : ''}`} onClick={() => goWorkspace(t.id)} title={`${t.label} (${shortcuts[`workspace.${t.id}`] ?? ''})`} aria-current={ws === t.id ? 'page' : undefined}>
            {t.star && <Sparkles size={11} className="star-icon" />}{t.label}
          </button>
        ))}
      </nav>
      <div className="topbar-spacer" />
      {tasks.slice(-2).map(t => (
        <div key={t.id} className="task-chip" title={t.detail}>
          <span className="task-label">{t.label}</span>
          <Progress value={t.done} total={t.total} indeterminate={!t.total} />
          <span className="dim">{t.total ? `${t.done}/${t.total}` : ''}</span>
          {t.cancel && <button className="icon-btn sm" onClick={t.cancel} aria-label="Cancel"><X size={12} /></button>}
        </div>
      ))}
      <div className="topbar-actions">
        <button className="btn sm" onClick={() => open('import')} title="Import photos"><Download size={14} />Import</button>
        <button className="icon-btn" onClick={() => open('shortcuts')} title="Keyboard shortcuts" aria-label="Keyboard shortcuts"><Keyboard size={16} /></button>
        <button className="icon-btn" onClick={() => open('settings')} title="Settings" aria-label="Settings"><Settings size={16} /></button>
      </div>
    </header>
  );
}

export const ShortcutHint = ({ action }: { action: string }) => {
  const s = useApp(st => st.settings?.shortcuts?.[action]) ?? DEFAULT_SHORTCUTS[action];
  return <Kbd combo={s} />;
};
