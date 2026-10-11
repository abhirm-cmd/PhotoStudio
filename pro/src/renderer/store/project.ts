/**
 * Project state with undo history. Every change goes through `edit()`, which
 * clones the project, applies the change and records a history entry. Rapid
 * changes with the same merge key (a slider drag) collapse into one entry.
 */
import { create } from 'zustand';
import { newProject, type Project, type MediaItem, type Clip } from '@shared/project';

interface Entry { project: Project; label: string }
const LIMIT = 300;

interface ProjectState {
  project: Project;
  file: string | null;
  /** Changes since the last save */
  dirty: boolean;
  past: Entry[];
  future: Entry[];
  lastLabel: string;
  edit(label: string, fn: (p: Project) => void, mergeKey?: string): void;
  /** Like edit, but applies the change to `base` (the state when a drag began), so live drags stay reversible */
  editFrom(base: Project, label: string, fn: (p: Project) => void, mergeKey: string): void;
  undo(): void;
  redo(): void;
  load(p: Project, file: string | null, dirty?: boolean): void;
  markSaved(file: string): void;
  /** Analysis results (thumbnails, waveforms, proxies) are not undoable edits */
  patchMedia(id: string, patch: Partial<MediaItem>): void;

  selection: string[];
  select(ids: string[], add?: boolean): void;
  selectedMediaId: string | null;
  selectMedia(id: string | null): void;
}

let lastMerge = { key: '', at: 0 };

/** Carry analysis fields over when an older snapshot comes back. */
function keepAnalysis(from: Project, to: Project): Project {
  const byId = new Map(from.media.map(m => [m.id, m]));
  return { ...to, media: to.media.map(m => { const c = byId.get(m.id); return c ? { ...m, thumbs: c.thumbs ?? m.thumbs, waveform: c.waveform ?? m.waveform, proxy: c.proxy ?? m.proxy, missing: c.missing } : m; }) };
}

export const useProject = create<ProjectState>((set, get) => ({
  project: newProject('Untitled'),
  file: null,
  dirty: false,
  past: [],
  future: [],
  lastLabel: '',
  edit: (label, fn, mergeKey) => get().editFrom(get().project, label, fn, mergeKey as string),
  editFrom: (base, label, fn, mergeKey) => {
    const s = get();
    const next = base === s.project ? structuredClone(base) : keepAnalysis(s.project, structuredClone(base));
    fn(next);
    next.modifiedAt = new Date().toISOString();
    const now = performance.now();
    const merge = !!mergeKey && lastMerge.key === mergeKey && now - lastMerge.at < 1500 && s.past.length > 0;
    lastMerge = { key: mergeKey ?? '', at: now };
    const past = merge ? s.past : [...s.past, { project: s.project, label }].slice(-LIMIT);
    // Keep selection valid
    const ids = new Set(next.clips.map(c => c.id));
    set({ project: next, past, future: [], dirty: true, lastLabel: label, selection: s.selection.filter(id => ids.has(id)) });
  },
  undo: () => {
    const s = get();
    const e = s.past[s.past.length - 1];
    if (!e) return;
    lastMerge = { key: '', at: 0 };
    set({ project: keepAnalysis(s.project, e.project), past: s.past.slice(0, -1), future: [{ project: s.project, label: e.label }, ...s.future], dirty: true, lastLabel: `Undo ${e.label}` });
  },
  redo: () => {
    const s = get();
    const e = s.future[0];
    if (!e) return;
    lastMerge = { key: '', at: 0 };
    set({ project: keepAnalysis(s.project, e.project), future: s.future.slice(1), past: [...s.past, { project: s.project, label: e.label }], dirty: true, lastLabel: `Redo ${e.label}` });
  },
  load: (project, file, dirty = false) => set({ project, file, dirty, past: [], future: [], selection: [], selectedMediaId: null, lastLabel: '' }),
  markSaved: file => set({ file, dirty: false }),
  patchMedia: (id, patch) => {
    const fix = (p: Project): Project => ({ ...p, media: p.media.map(m => (m.id === id ? { ...m, ...patch } : m)) });
    set(s => ({ project: fix(s.project) }));
  },

  selection: [],
  select: (ids, add) => set(s => ({ selection: add ? [...new Set([...s.selection, ...ids])] : ids })),
  selectedMediaId: null,
  selectMedia: selectedMediaId => set({ selectedMediaId }),
}));

export const P = () => useProject.getState().project;
export const selectedClips = (): Clip[] => { const s = useProject.getState(); return s.project.clips.filter(c => s.selection.includes(c.id)); };
