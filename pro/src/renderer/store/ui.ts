import { create } from 'zustand';

export type Page = 'media' | 'edit' | 'color' | 'audio' | 'deliver';
export interface Toast { id: number; kind: 'info' | 'success' | 'error'; title: string; body?: string; action?: { label: string; run(): void } }
export interface Task { id: string; label: string; progress: number | null }

interface UIState {
  page: Page;
  setPage(p: Page): void;
  toasts: Toast[];
  toast(t: Omit<Toast, 'id'>, ms?: number): void;
  dismissToast(id: number): void;
  tasks: Record<string, Task>;
  setTask(t: Task | { id: string; done: true }): void;
  shortcuts: boolean;
  setShortcuts(v: boolean): void;
  /** Which monitor keyboard transport controls (source viewer or timeline program) */
  activeMonitor: 'source' | 'program';
  setActiveMonitor(m: 'source' | 'program'): void;
}

let tid = 1;
export const useUI = create<UIState>((set, get) => ({
  page: 'edit',
  setPage: page => set({ page }),
  toasts: [],
  toast: (t, ms = 4500) => {
    const id = tid++;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    if (ms > 0) setTimeout(() => get().dismissToast(id), ms);
  },
  dismissToast: id => set({ toasts: get().toasts.filter(t => t.id !== id) }),
  tasks: {},
  setTask: t => {
    const tasks = { ...get().tasks };
    if ('done' in t) delete tasks[t.id]; else tasks[t.id] = t;
    set({ tasks });
  },
  shortcuts: false,
  setShortcuts: shortcuts => set({ shortcuts }),
  activeMonitor: 'program',
  setActiveMonitor: activeMonitor => set({ activeMonitor }),
}));

export const toast = (t: Omit<Toast, 'id'>, ms?: number) => useUI.getState().toast(t, ms);
