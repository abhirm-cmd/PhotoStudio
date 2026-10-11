/** Typed bridge to the Electron main process (exposed by preload as window.psp). */
import type { MediaItem, Project } from '@shared/project';
import type { ExportOptions, BuiltCommand } from '@shared/ffgraph';

interface Bridge {
  call(method: string, ...args: any[]): Promise<any>;
  on(channel: string, cb: (...args: any[]) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}
declare global { interface Window { psp: Bridge } }

const b = () => window.psp;
const call = <T = any>(m: string, ...a: any[]): Promise<T> => b().call(m, ...a);

export type Probed = Omit<MediaItem, 'id' | 'importedAt'>;
export interface ExportResult { ok: boolean; output?: string; error?: string; log?: string }
export interface ExportProgress { jobId: string; progress: number; seconds: number; eta: number | null; speed: number }

export const api = {
  on: (ch: string, cb: (...args: any[]) => void) => b().on(ch, cb),
  pathForFile: (f: File) => b().pathForFile(f),
  platform: () => b()?.platform ?? 'linux',

  appInfo: () => call<{ version: string; platform: string; isTest: boolean; ffmpeg: string; userData: string }>('app:info'),
  pickMedia: (kind: 'files' | 'folder') => call<string[]>('media:pick', kind),
  importMedia: (paths: string[]) => call<{ items: MediaItem[]; errors: { path: string; error: string }[] }>('media:import', paths),
  thumbs: (m: MediaItem) => call<NonNullable<MediaItem['thumbs']>>('media:thumbs', m),
  waveform: (m: MediaItem) => call<NonNullable<MediaItem['waveform']>>('media:waveform', m),
  proxy: (m: MediaItem) => call<string>('media:proxy', m),
  exists: (paths: string[]) => call<boolean[]>('media:exists', paths),
  relink: (name: string) => call<Probed | null>('media:relink', name),
  reveal: (p: string) => call('media:reveal', p),
  pickLut: () => call<{ path: string; name: string; text: string } | null>('lut:pick'),
  readLut: (p: string) => call<string | null>('lut:read', p),
  saveStill: (png: Uint8Array, name: string) => call<string | null>('still:save', png, name),

  openProject: (file?: string) => call<{ file: string; project: Project } | null>('project:open', file),
  saveProject: (p: Project, file: string | null, saveAs = false) => call<string | null>('project:save', p, file, saveAs),
  saveProjectTo: (p: Project, file: string) => call<string>('project:saveTo', p, file),
  autosave: (p: Project, file: string | null) => call('project:autosave', p, file),
  recover: () => call<{ project: Project; file: string | null; savedAt: string } | null>('project:recover'),
  clearAutosave: () => call('project:clearAutosave'),
  recent: () => call<string[]>('project:recent'),

  pickOutput: (name: string, ext: string) => call<string | null>('export:pickOutput', name, ext),
  defaultExportDir: () => call<string>('export:defaultDir'),
  startExport: (jobId: string, p: Project, o: ExportOptions, assets: { luts: Record<string, string>; titles: Record<string, Uint8Array> }) => call<ExportResult>('export:start', jobId, p, o, assets),
  cancelExport: (jobId: string) => call('export:cancel', jobId),
  exportCommand: (p: Project, o: ExportOptions) => call<BuiltCommand>('export:command', p, o),
  showInFolder: (p: string) => call('shell:reveal', p),
  openPath: (p: string) => call('shell:open', p),
  setTitle: (t: string) => call('window:title', t),
  /** Close the window (main asks the renderer first; this is the answer) */
  close: () => call('app:close'),
};

/** URL the player and <img> tags use for a local file or a cached asset. */
export const fileUrl = (p: string) => `media://file/?p=${encodeURIComponent(p)}`;
export const cacheUrl = (key: string) => `media://cache/${encodeURIComponent(key)}`;
