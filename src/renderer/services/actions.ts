/** Command registry: every keyboard shortcut and many menu items dispatch through here. */
import { useApp, type Workspace } from '../store/app';
import { useLibrary, activePhoto } from '../store/library';
import { useDevelop } from '../store/develop';
import { api } from '../api';
import { normalizeCombo, DEFAULT_SHORTCUTS } from '@shared/shortcuts';
import type { ColorLabel, Flag } from '@shared/types';
import { autoTone } from '../analysis/autoTone';
import { runAutoEnhance } from '../analysis/enhance';

const lib = () => useLibrary.getState();
const dev = () => useDevelop.getState();
const app = () => useApp.getState();

export async function setFlag(flag: Flag, ids = lib().targetIds()) {
  if (!ids.length) return;
  lib().patchPhotos(ids, { flag });
  await api.setFlag(ids, flag);
  advanceAfterCull();
}
export async function setRating(r: number, ids = lib().targetIds()) {
  if (!ids.length) return;
  lib().patchPhotos(ids, { rating: r });
  await api.setRating(ids, r);
  advanceAfterCull();
}
export async function setLabel(l: ColorLabel, ids = lib().targetIds()) {
  if (!ids.length) return;
  const cur = lib().photos.find(p => p.id === ids[0])?.label;
  const v = cur === l ? 'none' : l;
  lib().patchPhotos(ids, { label: v });
  await api.setLabel(ids, v);
}
export async function toggleFavorite(ids = lib().targetIds()) {
  if (!ids.length) return;
  const v = !lib().photos.find(p => p.id === ids[0])?.favorite;
  lib().patchPhotos(ids, { favorite: v });
  await api.setFavorite(ids, v);
}
// Culling flow: when one photo is selected in loupe/develop, rating moves on (like auto-advance) only if enabled.
let autoAdvance = false;
export const setAutoAdvance = (v: boolean) => { autoAdvance = v; };
function advanceAfterCull() { if (autoAdvance && lib().selection.length <= 1) lib().navigate(1); }

export function goWorkspace(w: Workspace) {
  const a = app();
  if (w !== 'library' && w !== 'presets' && w !== 'export' && lib().activeId == null) {
    const first = lib().selection[0] ?? lib().photos[0]?.id;
    if (first != null) lib().setActive(first);
  }
  a.setWorkspace(w);
}

export async function createVirtualCopy() {
  const p = activePhoto();
  if (!p) return;
  await dev().commit();
  const id = await api.virtualCopy(p.id);
  await lib().refresh();
  lib().setActive(id);
  app().toast({ kind: 'success', title: 'Virtual copy created', body: 'The copy has its own independent edits.' });
}

const handlers: Record<string, () => void> = {
  'workspace.library': () => { lib().setView('grid'); goWorkspace('library'); },
  'workspace.develop': () => goWorkspace('develop'),
  'workspace.masking': () => goWorkspace('masking'),
  'workspace.color': () => goWorkspace('color'),
  'workspace.presets': () => goWorkspace('presets'),
  'workspace.reference': () => goWorkspace('reference'),
  'workspace.compare': () => goWorkspace('compare'),
  'workspace.export': () => goWorkspace('export'),
  'view.loupe': () => { if (app().workspace !== 'library') goWorkspace('library'); lib().setView(lib().view === 'loupe' ? 'grid' : 'loupe'); },
  'view.survey': () => { if (app().workspace !== 'library') goWorkspace('library'); lib().setView('survey'); },
  'view.fullscreen': () => api.toggleFullscreen(),
  'view.zoomToggle': () => dev().set({ zoom: dev().zoom === 'fit' ? 1 : 'fit', center: [0.5, 0.5] }),
  'view.zoomIn': () => { const z = dev().zoom; dev().set({ zoom: typeof z === 'number' ? Math.min(8, z * 1.5) : 1 }); },
  'view.zoomOut': () => { const z = dev().zoom; dev().set({ zoom: typeof z === 'number' && z > 0.15 ? z / 1.5 : 'fit' }); },
  'view.fit': () => dev().set({ zoom: 'fit', center: [0.5, 0.5] }),
  'view.clipping': () => dev().set({ clipping: !dev().clipping }),
  'view.beforeAfter': () => dev().setCompare(dev().compare === 'off' ? 'before' : 'off'),
  'view.splitCycle': () => { const order = ['off', 'split-v', 'split-h', 'side'] as const; const i = order.indexOf(dev().compare as any); dev().setCompare(order[(i + 1) % order.length]); },
  'view.togglePanels': () => { const a = app(); const hide = a.leftOpen || a.rightOpen; a.setPanel({ leftOpen: !hide, rightOpen: !hide }); },
  'tool.crop': () => { if (!['develop', 'masking', 'color'].includes(app().workspace)) goWorkspace('develop'); dev().setTool('crop'); },
  'tool.mask': () => goWorkspace('masking'),
  'tool.wbPicker': () => { if (app().workspace === 'library') goWorkspace('develop'); dev().setTool('wb'); },
  'tool.brush': () => { goWorkspace('masking'); dev().setTool('brush'); },
  'flag.pick': () => setFlag('pick'),
  'flag.reject': () => setFlag('reject'),
  'flag.unflag': () => setFlag('none'),
  'rate.0': () => setRating(0), 'rate.1': () => setRating(1), 'rate.2': () => setRating(2), 'rate.3': () => setRating(3), 'rate.4': () => setRating(4), 'rate.5': () => setRating(5),
  'label.red': () => setLabel('red'), 'label.yellow': () => setLabel('yellow'), 'label.green': () => setLabel('green'), 'label.blue': () => setLabel('blue'),
  'favorite.toggle': () => toggleFavorite(),
  'nav.next': () => lib().navigate(1),
  'nav.prev': () => lib().navigate(-1),
  'nav.up': () => lib().navigate(-gridColumns()),
  'nav.down': () => lib().navigate(gridColumns()),
  'edit.undo': () => dev().undo(),
  'edit.redo': () => dev().redo(),
  'edit.save': async () => { await dev().commit(); app().toast({ kind: 'success', title: 'Saved', body: 'Edits and metadata are stored in the catalog.' }); },
  'edit.copySettings': () => { dev().copySettings(); app().toast({ kind: 'info', title: 'Settings copied', body: 'Paste onto other photos with the paste shortcut or Sync.' }); },
  'edit.pasteSettings': async () => { const n = await dev().pasteSettings(); if (n) app().toast({ kind: 'success', title: `Settings pasted to ${n} photo${n > 1 ? 's' : ''}` }); },
  'edit.syncSettings': () => app().openModal('syncSettings'),
  'edit.reset': () => dev().resetAll(),
  'edit.autoTone': () => autoTone(),
  'edit.virtualCopy': () => createVirtualCopy(),
  'edit.autoEnhance': () => runAutoEnhance(0.7),
  'library.selectAll': () => lib().setSelection(lib().photos.map(p => p.id), lib().activeId),
  'library.deselect': () => lib().setSelection(lib().activeId != null ? [lib().activeId!] : []),
  'library.import': () => app().openModal('import'),
  'library.search': () => (document.getElementById('library-search') as HTMLInputElement | null)?.focus(),
  'app.settings': () => app().openModal('settings'),
  'app.shortcuts': () => app().openModal('shortcuts'),
  'backup.now': async () => { try { const b = await api.backupNow(); app().toast({ kind: 'success', title: 'Catalog backed up', body: b.path }); } catch (e: any) { app().toast({ kind: 'error', title: 'Backup failed', body: e.message }); } },
};

export function runAction(id: string) { handlers[id]?.(); }

let gridCols = 6;
export const setGridColumns = (n: number) => { gridCols = Math.max(1, n); };
const gridColumns = () => (app().workspace === 'library' && lib().view === 'grid' ? gridCols : 1);

export function installShortcuts() {
  const isMac = (window as any).photostudio?.platform === 'darwin';
  window.addEventListener('keydown', e => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (app().modal && e.key !== 'Escape') return;
    if (t?.getAttribute?.('role') === 'slider' && /^Arrow|Home|End/.test(e.key)) return;
    const combo = normalizeCombo(e, isMac);
    if (e.key === 'Escape') {
      if (dev().tool !== 'none') { dev().set({ tool: 'none' }); e.preventDefault(); return; }
      if (dev().compare !== 'off') { dev().setCompare('off'); return; }
    }
    const map = app().settings?.shortcuts ?? DEFAULT_SHORTCUTS;
    const action = Object.keys(map).find(k => map[k] === combo);
    if (!action) return;
    // Navigation keys in the grid are handled by arrow logic; in develop, left/right move through the filmstrip
    e.preventDefault();
    runAction(action);
  });
}
