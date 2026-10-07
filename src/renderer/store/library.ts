import { create } from 'zustand';
import type { Collection, FolderNode, Photo, SmartRule, SmartRuleSet, CatalogStats } from '@shared/types';
import { api } from '../api';
import { parseSearch, looksNatural } from '@shared/nlsearch';

export type Source = { kind: 'all' } | { kind: 'folder'; path: string } | { kind: 'collection'; id: number } | { kind: 'picks' } | { kind: 'rejects' } | { kind: 'favorites' } | { kind: 'recent' } | { kind: 'edited' } | { kind: 'errors' };

export interface QuickFilter {
  minRating: number;
  ratingOp: 'gte' | 'is' | 'lte';
  flag: 'any' | 'pick' | 'reject' | 'none' | 'notReject';
  labels: string[];
  edited: 'any' | 'edited' | 'unedited';
  type: 'any' | 'raw' | 'other';
  camera: string;
  lens: string;
  keyword: string;
  extra: SmartRule[];
}

export const emptyFilter = (): QuickFilter => ({ minRating: 0, ratingOp: 'gte', flag: 'any', labels: [], edited: 'any', type: 'any', camera: '', lens: '', keyword: '', extra: [] });

export type ViewMode = 'grid' | 'loupe' | 'survey' | 'compare';

interface LibraryState {
  photos: Photo[];
  loading: boolean;
  source: Source;
  search: string;
  searchChips: string[];
  filter: QuickFilter;
  sort: 'date' | 'imported' | 'filename' | 'rating' | 'edited';
  sortDir: 'asc' | 'desc';
  selection: number[];
  activeId: number | null;
  anchorId: number | null;
  compareIds: [number | null, number | null];
  view: ViewMode;
  thumbSize: number;
  thumbVersions: Record<number, number>;
  collections: Collection[];
  folders: FolderNode[];
  stats: CatalogStats | null;
  distinct: { cameras: string[]; lenses: string[]; exts: string[]; presets: string[]; keywords: string[]; aiTags: string[] };
  refresh(): Promise<void>;
  refreshMeta(): Promise<void>;
  setSource(s: Source): void;
  setSearch(q: string): void;
  setFilter(p: Partial<QuickFilter>): void;
  clearFilter(): void;
  setSort(sort: LibraryState['sort'], dir?: 'asc' | 'desc'): void;
  select(id: number, mode?: 'single' | 'toggle' | 'range'): void;
  setSelection(ids: number[], active?: number | null): void;
  setActive(id: number | null): void;
  navigate(delta: number): void;
  setView(v: ViewMode): void;
  setThumbSize(n: number): void;
  patchPhotos(ids: number[], patch: Partial<Photo>): void;
  replacePhoto(p: Photo): void;
  bumpThumb(id: number): void;
  targetIds(): number[];
}

function buildRules(s: LibraryState): { rules: SmartRuleSet | null; text: string; chips: string[] } {
  const r: SmartRule[] = [];
  const f = s.filter;
  if (f.minRating > 0 || f.ratingOp === 'is') r.push({ field: 'rating', op: f.ratingOp, value: f.minRating });
  if (f.flag === 'pick' || f.flag === 'reject' || f.flag === 'none') r.push({ field: 'flag', op: 'is', value: f.flag });
  if (f.flag === 'notReject') r.push({ field: 'flag', op: 'isNot', value: 'reject' });
  if (f.edited !== 'any') r.push({ field: 'edited', op: 'is', value: f.edited === 'edited' });
  if (f.type !== 'any') r.push({ field: 'isRaw', op: 'is', value: f.type === 'raw' });
  if (f.camera) r.push({ field: 'camera', op: 'is', value: f.camera });
  if (f.lens) r.push({ field: 'lens', op: 'is', value: f.lens });
  if (f.keyword) r.push({ field: 'keyword', op: 'is', value: f.keyword });
  r.push(...f.extra);
  const src = s.source;
  if (src.kind === 'picks') r.push({ field: 'flag', op: 'is', value: 'pick' });
  if (src.kind === 'rejects') r.push({ field: 'flag', op: 'is', value: 'reject' });
  if (src.kind === 'favorites') r.push({ field: 'favorite', op: 'is', value: true });
  if (src.kind === 'edited') r.push({ field: 'edited', op: 'is', value: true });
  let text = s.search.trim();
  let chips: string[] = [];
  if (text && looksNatural(text)) {
    const parsed = parseSearch(text, s.distinct);
    r.push(...parsed.rules);
    text = parsed.text;
    chips = parsed.chips;
  }
  const base: SmartRuleSet = { match: 'all', rules: r };
  // Labels are OR'ed among themselves
  if (f.labels.length === 1) base.rules.push({ field: 'label', op: 'is', value: f.labels[0] });
  return { rules: base.rules.length ? base : null, text, chips };
}

let refreshSeq = 0;

export const useLibrary = create<LibraryState>((set, get) => ({
  photos: [],
  loading: true,
  source: { kind: 'all' },
  search: '',
  searchChips: [],
  filter: emptyFilter(),
  sort: 'date',
  sortDir: 'desc',
  selection: [],
  activeId: null,
  anchorId: null,
  compareIds: [null, null],
  view: 'grid',
  thumbSize: 190,
  thumbVersions: {},
  collections: [],
  folders: [],
  stats: null,
  distinct: { cameras: [], lenses: [], exts: [], presets: [], keywords: [], aiTags: [] },

  refresh: async () => {
    const seq = ++refreshSeq;
    const s = get();
    const { rules, text, chips } = buildRules(s);
    const src = s.source;
    let photos = await api.queryPhotos({
      text, rules, sort: s.sort, sortDir: s.sortDir,
      folder: src.kind === 'folder' ? src.path : null,
      collectionId: src.kind === 'collection' ? src.id : null,
    });
    if (seq !== refreshSeq) return;
    if (s.filter.labels.length > 1) photos = photos.filter(p => s.filter.labels.includes(p.label));
    if (src.kind === 'recent') {
      const latest = photos.reduce((m, p) => (p.importedAt > m ? p.importedAt : m), '');
      const cutoff = new Date(new Date(latest).getTime() - 10 * 60_000).toISOString();
      photos = photos.filter(p => p.importedAt >= cutoff);
    }
    if (src.kind === 'errors') photos = photos.filter(p => p.thumbState === 'error');
    const ids = new Set(photos.map(p => p.id));
    const selection = s.selection.filter(i => ids.has(i));
    let activeId = s.activeId != null && ids.has(s.activeId) ? s.activeId : null;
    if (activeId == null && photos.length && s.view !== 'grid') activeId = photos[0].id;
    set({ photos, loading: false, selection: selection.length ? selection : activeId != null ? [activeId] : [], activeId, searchChips: chips });
  },

  refreshMeta: async () => {
    const [collections, folders, stats, distinct] = await Promise.all([api.collections(), api.folders(), api.stats(), api.distinct()]);
    set({ collections, folders, stats, distinct });
  },

  setSource: source => { set({ source, selection: [], activeId: null }); get().refresh(); },
  setSearch: q => { set({ search: q }); get().refresh(); },
  setFilter: p => { set(s => ({ filter: { ...s.filter, ...p } })); get().refresh(); },
  clearFilter: () => { set({ filter: emptyFilter(), search: '' }); get().refresh(); },
  setSort: (sort, dir) => { set(s => ({ sort, sortDir: dir ?? s.sortDir })); get().refresh(); },

  select: (id, mode = 'single') => {
    const s = get();
    if (mode === 'toggle') {
      const has = s.selection.includes(id);
      const selection = has ? s.selection.filter(x => x !== id) : [...s.selection, id];
      set({ selection, activeId: has ? (selection[selection.length - 1] ?? null) : id, anchorId: id });
    } else if (mode === 'range' && s.anchorId != null) {
      const ids = s.photos.map(p => p.id);
      const a = ids.indexOf(s.anchorId), b = ids.indexOf(id);
      if (a < 0 || b < 0) return set({ selection: [id], activeId: id, anchorId: id });
      const [lo, hi] = a < b ? [a, b] : [b, a];
      set({ selection: ids.slice(lo, hi + 1), activeId: id });
    } else set({ selection: [id], activeId: id, anchorId: id });
  },
  setSelection: (ids, active) => set({ selection: ids, activeId: active === undefined ? (ids[0] ?? null) : active }),
  setActive: id => set(s => ({ activeId: id, selection: id == null ? [] : s.selection.includes(id) && s.selection.length > 1 ? s.selection : [id], anchorId: id })),
  navigate: delta => {
    const s = get();
    if (!s.photos.length) return;
    const idx = s.photos.findIndex(p => p.id === s.activeId);
    const next = s.photos[Math.max(0, Math.min(s.photos.length - 1, (idx < 0 ? 0 : idx) + delta))];
    if (next) set({ activeId: next.id, selection: [next.id], anchorId: next.id });
  },
  setView: v => set(s => ({ view: v, activeId: s.activeId ?? s.selection[0] ?? s.photos[0]?.id ?? null })),
  setThumbSize: n => set({ thumbSize: n }),
  patchPhotos: (ids, patch) => set(s => ({ photos: s.photos.map(p => (ids.includes(p.id) ? { ...p, ...patch } : p)) })),
  replacePhoto: p => set(s => ({ photos: s.photos.map(x => (x.id === p.id ? p : x)) })),
  bumpThumb: id => set(s => ({ thumbVersions: { ...s.thumbVersions, [id]: (s.thumbVersions[id] ?? 0) + 1 } })),
  targetIds: () => { const s = get(); return s.selection.length ? s.selection : s.activeId != null ? [s.activeId] : []; },
}));

export const activePhoto = () => { const s = useLibrary.getState(); return s.photos.find(p => p.id === s.activeId) ?? null; };
