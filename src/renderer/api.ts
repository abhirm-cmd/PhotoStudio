/** Typed bridge to the Electron main process (exposed by preload as window.lumora). */
import type { AppSettings, BackupInfo, CatalogStats, Collection, ExportPreset, ExportSettings, FolderNode, HistoryEntry, ImportOptions, IptcMeta, LensProfile, Photo, PhotoQuery, Preset, Snapshot, SmartRuleSet } from '@shared/types';
import type { EditParams } from '@shared/edit';

interface Bridge {
  call(method: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (...args: any[]) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}

declare global { interface Window { lumora: Bridge } }

const b = () => window.lumora;
const call = <T = any>(m: string, ...a: any[]): Promise<T> => b().call(m, ...a);

export const api = {
  on: (ch: string, cb: (...args: any[]) => void) => b().on(ch, cb),
  pathForFile: (f: File) => b().pathForFile(f),
  platform: () => b()?.platform ?? 'linux',

  appInfo: () => call<{ version: string; platform: string; userData: string; catalogFile: string; isDev: boolean; isTest: boolean }>('app:info'),
  getSettings: () => call<AppSettings>('settings:get'),
  updateSettings: (patch: any) => call<AppSettings>('settings:update', patch),

  queryPhotos: (q: PhotoQuery) => call<Photo[]>('photos:query', q),
  getPhoto: (id: number) => call<Photo | undefined>('photos:get', id),
  getPhotos: (ids: number[]) => call<Photo[]>('photos:getMany', ids),
  setRating: (ids: number[], r: number) => call('photos:setRating', ids, r),
  setFlag: (ids: number[], f: string) => call('photos:setFlag', ids, f),
  setLabel: (ids: number[], l: string) => call('photos:setLabel', ids, l),
  setFavorite: (ids: number[], v: boolean) => call('photos:setFavorite', ids, v),
  addKeywords: (ids: number[], w: string[]) => call('photos:addKeywords', ids, w),
  removeKeyword: (ids: number[], w: string) => call('photos:removeKeyword', ids, w),
  setIptc: (ids: number[], m: Partial<IptcMeta>) => call('photos:setIptc', ids, m),
  setAiTags: (id: number, tags: string[]) => call('photos:setAiTags', id, tags),
  removePhotos: (ids: number[]) => call('photos:remove', ids),
  retryPreview: (id: number) => call<Photo>('photos:retryPreview', id),
  reveal: (id: number) => call('photos:reveal', id),
  virtualCopy: (id: number, name?: string) => call<number>('photos:virtualCopy', id, name),
  distinct: () => call<{ cameras: string[]; lenses: string[]; exts: string[]; presets: string[]; keywords: string[]; aiTags: string[] }>('photos:distinct'),
  stats: () => call<CatalogStats>('photos:stats'),
  folders: () => call<FolderNode[]>('photos:folders'),
  storeRendered: (id: number, jpeg: Uint8Array) => call('photos:storeRendered', id, jpeg),
  reportIssue: (id: number) => call<string>('photos:reportIssue', id),

  getEdit: (id: number) => call<EditParams | null>('edit:get', id),
  saveEdit: (id: number, e: EditParams, opts?: { historyLabel?: string; presetName?: string | null; aiEnhanced?: boolean }) => call<number | null>('edit:save', id, e, opts),
  history: (id: number) => call<HistoryEntry[]>('history:get', id),
  truncateHistory: (id: number, after: number) => call('history:truncate', id, after),
  snapshots: (id: number) => call<Snapshot[]>('snapshots:get', id),
  addSnapshot: (id: number, name: string, e: EditParams) => call('snapshots:add', id, name, e),
  deleteSnapshot: (sid: number) => call('snapshots:delete', sid),

  collections: () => call<Collection[]>('collections:list'),
  createCollection: (name: string, kind: Collection['kind'], rules?: SmartRuleSet | null) => call<number>('collections:create', name, kind, rules ?? null),
  updateCollection: (id: number, patch: { name?: string; rules?: SmartRuleSet | null }) => call('collections:update', id, patch),
  deleteCollection: (id: number) => call('collections:delete', id),
  addToCollection: (cid: number, ids: number[]) => call('collections:add', cid, ids),
  removeFromCollection: (cid: number, ids: number[]) => call('collections:removePhotos', cid, ids),

  presets: () => call<Preset[]>('presets:list'),
  savePreset: (p: Preset) => call('presets:save', p),
  deletePreset: (id: string) => call('presets:delete', id),
  exportPresets: (ps: Preset[]) => call<string | null>('presets:export', ps),
  importPresets: () => call<Preset[]>('presets:import'),
  exportPresetList: () => call<ExportPreset[]>('exportPresets:list'),
  saveExportPreset: (p: ExportPreset) => call('exportPresets:save', p),
  deleteExportPreset: (id: string) => call('exportPresets:delete', id),

  putBlob: (key: string, mime: string, data: Uint8Array) => call('blobs:put', key, mime, data),

  pickImport: (kind: 'files' | 'folder') => call<string[]>('import:pick', kind),
  scanCount: (paths: string[], recursive: boolean) => call<number>('import:scan', paths, recursive),
  startImport: (o: ImportOptions) => call<string>('import:start', o),
  cancelImport: (id: string) => call('import:cancel', id),
  importDemo: () => call<string | null>('import:demo'),
  rawThumbResult: (reqId: string, r: any) => call('raw:thumb-result', reqId, r),

  pickFolder: (title?: string) => call<string | null>('dialog:pickFolder', title),
  pickImage: () => call<string | null>('dialog:pickImage'),
  openTextFiles: (title: string, exts: string[]) => call<{ name: string; text: string }[]>('dialog:openTextFiles', title, exts),
  lensProfiles: () => call<LensProfile[]>('lens:list'),
  saveLensProfiles: (p: LensProfile[]) => call('lens:save', p),
  revealPath: (p: string) => call('shell:reveal', p),
  openPath: (p: string) => call('shell:open', p),

  exportDefaultDir: () => call<string>('export:defaultDir'),
  exportWrite: (id: number, px: Uint8Array | Uint16Array, w: number, h: number, s: ExportSettings, seq: number) => call<string | null>('export:write', id, px, w, h, s, seq),

  backups: () => call<BackupInfo[]>('backup:list'),
  backupNow: () => call<BackupInfo>('backup:create'),
  restoreBackup: (f: string) => call('backup:restore', f),
  cacheSize: () => call<number>('cache:size'),
  clearCache: () => call('cache:clear'),
  toggleFullscreen: () => call('window:toggleFullscreen'),
};

export const media = {
  thumb: (id: number, v?: string | number) => `media://thumb/${id}${v ? `?v=${v}` : ''}`,
  preview: (id: number, v?: string | number) => `media://preview/${id}${v ? `?v=${v}` : ''}`,
  original: (id: number) => `media://original/${id}`,
  decoded: (id: number, max?: number) => `media://decoded/${id}${max ? `?max=${max}` : ''}`,
  reference: (path: string) => `media://reference/x?path=${encodeURIComponent(path)}`,
  blob: (key: string) => `media://blob/${encodeURIComponent(key)}`,
};
