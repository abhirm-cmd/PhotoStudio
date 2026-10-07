import { create } from 'zustand';
import type { AppSettings } from '@shared/types';
import { api } from '../api';

export type Workspace = 'library' | 'develop' | 'masking' | 'color' | 'presets' | 'reference' | 'compare' | 'export';
export type Modal = null | 'import' | 'settings' | 'shortcuts' | 'smartCollection' | 'savePreset' | 'syncSettings' | 'pasteSettings' | 'restore';

export interface Toast { id: number; kind: 'info' | 'success' | 'error'; title: string; body?: string; action?: { label: string; run: () => void }; ttl?: number }

export interface Task { id: string; label: string; done: number; total: number; detail?: string; cancel?: () => void }

interface AppState {
  workspace: Workspace;
  prevWorkspace: Workspace;
  settings: AppSettings | null;
  modal: Modal;
  modalProps: any;
  toasts: Toast[];
  tasks: Task[];
  leftOpen: boolean;
  rightOpen: boolean;
  filmstripOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  panelsHidden: boolean;
  platform: string;
  setWorkspace(w: Workspace): void;
  setSettings(s: AppSettings): void;
  updateSettings(patch: any): Promise<void>;
  openModal(m: Modal, props?: any): void;
  closeModal(): void;
  toast(t: Omit<Toast, 'id'>): number;
  dismissToast(id: number): void;
  setTask(t: Task): void;
  endTask(id: string): void;
  setPanel(patch: Partial<Pick<AppState, 'leftOpen' | 'rightOpen' | 'filmstripOpen' | 'leftWidth' | 'rightWidth' | 'panelsHidden'>>): void;
}

let toastSeq = 0;
let panelSaveTimer: any = null;

export const useApp = create<AppState>((set, get) => ({
  workspace: 'library',
  prevWorkspace: 'library',
  settings: null,
  modal: null,
  modalProps: null,
  toasts: [],
  tasks: [],
  leftOpen: true,
  rightOpen: true,
  filmstripOpen: true,
  leftWidth: 248,
  rightWidth: 316,
  panelsHidden: false,
  platform: 'linux',
  setWorkspace: w => set(s => (s.workspace === w ? s : { workspace: w, prevWorkspace: s.workspace })),
  setSettings: s => {
    const p = s.panels ?? {};
    set({ settings: s, leftOpen: p.leftOpen ?? true, rightOpen: p.rightOpen ?? true, filmstripOpen: p.filmstripOpen ?? true, leftWidth: p.leftWidth ?? 248, rightWidth: p.rightWidth ?? 316 });
    applyUiSettings(s);
  },
  updateSettings: async patch => {
    const s = await api.updateSettings(patch);
    set({ settings: s });
    applyUiSettings(s);
  },
  openModal: (m, props) => set({ modal: m, modalProps: props ?? null }),
  closeModal: () => set({ modal: null, modalProps: null }),
  toast: t => {
    const id = ++toastSeq;
    set(s => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    const ttl = t.ttl ?? (t.kind === 'error' ? 8000 : 3800);
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  setTask: t => set(s => ({ tasks: s.tasks.some(x => x.id === t.id) ? s.tasks.map(x => (x.id === t.id ? t : x)) : [...s.tasks, t] })),
  endTask: id => set(s => ({ tasks: s.tasks.filter(t => t.id !== id) })),
  setPanel: patch => {
    set(patch as any);
    clearTimeout(panelSaveTimer);
    panelSaveTimer = setTimeout(() => {
      const s = get();
      api.updateSettings({ panels: { leftOpen: s.leftOpen, rightOpen: s.rightOpen, filmstripOpen: s.filmstripOpen, leftWidth: s.leftWidth, rightWidth: s.rightWidth } }).catch(() => {});
    }, 400);
  },
}));

function applyUiSettings(s: AppSettings) {
  document.documentElement.style.setProperty('--ui-scale', String(s.general.uiScale || 1));
  document.documentElement.dataset.theme = s.general.theme;
}

export const toast = (t: Omit<Toast, 'id'>) => useApp.getState().toast(t);
