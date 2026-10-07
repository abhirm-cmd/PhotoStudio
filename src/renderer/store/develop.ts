import { create } from 'zustand';
import { cloneEdit, defaultEdit, describeChange, normalizeEdit, pickGroups, applyPartial, type EditParams, type SettingGroup, DEFAULT_PRESET_GROUPS, ALL_GROUPS } from '@shared/edit';
import type { Photo } from '@shared/types';
import { api } from '../api';
import { useLibrary } from './library';

export type Tool = 'none' | 'crop' | 'wb' | 'upright-guides' | 'brush' | 'linear' | 'radial' | 'color-pick' | 'lum-pick' | 'targeted' | 'object' | 'histo';
export type CompareMode = 'off' | 'before' | 'split-v' | 'split-h' | 'side';

interface HistoryItem { id: number | null; label: string; edit: EditParams }

interface DevelopState {
  photoId: number | null;
  isRaw: boolean;
  edit: EditParams;
  committed: EditParams;
  history: HistoryItem[];
  index: number;
  previewEdit: EditParams | null;
  previewLabel: string | null;
  tool: Tool;
  targetedMode: 'hue' | 'saturation' | 'luminance' | 'curve';
  compare: CompareMode;
  split: number;
  holdBefore: boolean;
  clipping: boolean;
  zoom: 'fit' | 'fill' | number;
  center: [number, number];
  selectedMask: string | null;
  selectedComponent: string | null;
  maskOverlay: boolean;
  brush: { size: number; feather: number; flow: number; erase: boolean; autoMask: boolean };
  clipboard: { settings: Partial<EditParams>; groups: SettingGroup[] } | null;
  asShot: { temp: number; tint: number };
  loadingSource: boolean;
  sourceError: { message: string; detail: string } | null;
  renderMs: number;
  load(photo: Photo): Promise<void>;
  unload(): void;
  setEdit(fn: (e: EditParams) => void | EditParams, commitLabel?: string): void;
  replaceEdit(e: EditParams, label: string, opts?: { presetName?: string | null; aiEnhanced?: boolean }): void;
  commit(label?: string): Promise<void>;
  undo(): void;
  redo(): void;
  jumpTo(i: number): void;
  setPreview(e: EditParams | null, label?: string | null): void;
  setTool(t: Tool): void;
  setCompare(c: CompareMode): void;
  set(p: Partial<DevelopState>): void;
  copySettings(groups?: SettingGroup[]): void;
  pasteSettings(ids?: number[], groups?: SettingGroup[]): Promise<number>;
  resetAll(): void;
  setAsShot(a: { temp: number; tint: number }): void;
}

let saveTimer: any = null;
const thumbListeners = new Set<(id: number) => void>();
export const onEditCommitted = (fn: (id: number) => void) => { thumbListeners.add(fn); return () => thumbListeners.delete(fn); };

export const useDevelop = create<DevelopState>((set, get) => ({
  photoId: null,
  isRaw: true,
  edit: defaultEdit(true),
  committed: defaultEdit(true),
  history: [],
  index: -1,
  previewEdit: null,
  previewLabel: null,
  tool: 'none',
  targetedMode: 'saturation',
  compare: 'off',
  split: 0.5,
  holdBefore: false,
  clipping: false,
  zoom: 'fit',
  center: [0.5, 0.5],
  selectedMask: null,
  selectedComponent: null,
  maskOverlay: true,
  brush: { size: 120, feather: 60, flow: 70, erase: false, autoMask: false },
  clipboard: null,
  asShot: { temp: 5500, tint: 0 },
  loadingSource: false,
  sourceError: null,
  renderMs: 0,

  load: async photo => {
    if (get().photoId === photo.id) return;
    await get().commit();
    const [saved, hist] = await Promise.all([api.getEdit(photo.id), api.history(photo.id)]);
    const edit = saved ? normalizeEdit(saved, photo.isRaw) : defaultEdit(photo.isRaw);
    let history: HistoryItem[] = hist.map(h => ({ id: h.id, label: h.label, edit: normalizeEdit(h.edit, photo.isRaw) }));
    if (!history.length) history = [{ id: null, label: 'Import', edit: cloneEdit(edit) }];
    set({
      photoId: photo.id, isRaw: photo.isRaw, edit, committed: cloneEdit(edit), history, index: history.length - 1,
      previewEdit: null, selectedMask: edit.masks[0]?.id ?? null, selectedComponent: null, sourceError: null,
      zoom: 'fit', center: [0.5, 0.5], tool: get().tool === 'crop' ? 'crop' : 'none',
    });
  },
  unload: () => set({ photoId: null }),

  setEdit: (fn, commitLabel) => {
    const e = cloneEdit(get().edit);
    const r = fn(e);
    set({ edit: r ?? e });
    if (commitLabel !== undefined) get().commit(commitLabel || undefined);
  },

  replaceEdit: (e, label, opts) => {
    set({ edit: cloneEdit(e) });
    get().commit(label);
    const id = get().photoId;
    if (id != null && opts) api.saveEdit(id, get().edit, opts).then(() => useLibrary.getState().patchPhotos([id], { presetName: opts.presetName ?? undefined, aiEnhanced: opts.aiEnhanced ?? undefined } as any));
  },

  commit: async label => {
    const s = get();
    if (s.photoId == null) return;
    if (JSON.stringify(s.edit) === JSON.stringify(s.committed)) return;
    const lbl = label ?? describeChange(s.committed, s.edit);
    const id = s.photoId;
    let history = s.history.slice(0, s.index + 1);
    const truncateAfter = s.index < s.history.length - 1 ? s.history[s.index].id : null;
    const item: HistoryItem = { id: null, label: lbl, edit: cloneEdit(s.edit) };
    history.push(item);
    set({ committed: cloneEdit(s.edit), history, index: history.length - 1 });
    if (truncateAfter != null) await api.truncateHistory(id, truncateAfter);
    item.id = await api.saveEdit(id, s.edit, { historyLabel: lbl });
    useLibrary.getState().patchPhotos([id], { hasEdits: true, editedAt: new Date().toISOString() });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => thumbListeners.forEach(f => f(id)), 900);
  },

  undo: () => {
    const s = get();
    if (s.index <= 0 || s.photoId == null) return;
    const i = s.index - 1;
    const e = cloneEdit(s.history[i].edit);
    set({ index: i, edit: e, committed: cloneEdit(e) });
    api.saveEdit(s.photoId, e);
    const id = s.photoId;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => thumbListeners.forEach(f => f(id)), 900);
  },
  redo: () => {
    const s = get();
    if (s.index >= s.history.length - 1 || s.photoId == null) return;
    const i = s.index + 1;
    const e = cloneEdit(s.history[i].edit);
    set({ index: i, edit: e, committed: cloneEdit(e) });
    api.saveEdit(s.photoId, e);
  },
  jumpTo: i => {
    const s = get();
    if (i < 0 || i >= s.history.length || s.photoId == null) return;
    const e = cloneEdit(s.history[i].edit);
    set({ index: i, edit: e, committed: cloneEdit(e) });
    api.saveEdit(s.photoId, e);
  },

  setPreview: (e, label = null) => set({ previewEdit: e, previewLabel: label }),
  setTool: t => set(s => ({ tool: s.tool === t ? 'none' : t })),
  setCompare: c => set({ compare: c }),
  set: p => set(p as any),

  copySettings: groups => {
    const s = get();
    const g = groups ?? ALL_GROUPS.filter(x => x !== 'crop');
    set({ clipboard: { settings: pickGroups(s.edit, g), groups: g } });
  },

  pasteSettings: async (ids, groups) => {
    const s = get();
    if (!s.clipboard) return 0;
    const settings = groups ? Object.fromEntries(Object.entries(s.clipboard.settings).filter(([k]) => groups.some(g => (SETTING_KEYS[g] as readonly string[]).includes(k)))) : s.clipboard.settings;
    const targets = ids ?? useLibrary.getState().targetIds();
    let n = 0;
    for (const id of targets) {
      if (id === s.photoId) {
        get().replaceEdit(applyPartial(s.edit, settings as any), 'Paste Settings');
      } else {
        const p = useLibrary.getState().photos.find(x => x.id === id);
        const cur = normalizeEdit(await api.getEdit(id), p?.isRaw ?? true);
        const next = applyPartial(cur, remapMasks(settings as any));
        await api.saveEdit(id, next, { historyLabel: 'Paste Settings' });
        thumbListeners.forEach(f => f(id));
      }
      n++;
    }
    useLibrary.getState().patchPhotos(targets, { hasEdits: true });
    return n;
  },

  resetAll: () => {
    const s = get();
    const d = defaultEdit(s.isRaw);
    d.wb = { mode: 'asShot', temp: s.asShot.temp, tint: s.asShot.tint };
    get().replaceEdit(d, 'Reset');
  },

  setAsShot: a => {
    const s = get();
    set({ asShot: a });
    // Fill in as-shot white balance for unmodified edits (no history entry)
    if (s.edit.wb.mode === 'asShot' && (s.edit.wb.temp !== a.temp || s.edit.wb.tint !== a.tint)) {
      const fix = (e: EditParams) => ({ ...e, wb: { mode: 'asShot' as const, temp: a.temp, tint: a.tint } });
      set({ edit: fix(s.edit), committed: fix(s.committed), history: s.history.map(h => (h.edit.wb.mode === 'asShot' ? { ...h, edit: fix(h.edit) } : h)) });
    }
  },
}));

import { SETTING_GROUPS } from '@shared/edit';
const SETTING_KEYS = Object.fromEntries(Object.entries(SETTING_GROUPS).map(([k, v]) => [k, v.keys])) as unknown as Record<SettingGroup, readonly string[]>;

/** Masks pasted onto another photo get fresh ids so they stay independent. */
function remapMasks(settings: Partial<EditParams>): Partial<EditParams> {
  if (!settings.masks) return settings;
  return { ...settings, masks: settings.masks.map(m => ({ ...structuredClone(m), id: m.id + '-' + Math.random().toString(36).slice(2, 6) })) };
}

export const presetDefaults = DEFAULT_PRESET_GROUPS;
