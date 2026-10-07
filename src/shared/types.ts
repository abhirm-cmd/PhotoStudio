import type { EditParams, SettingGroup } from './edit';

export type Flag = 'pick' | 'reject' | 'none';
export type ColorLabel = 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';

export interface PhotoExif {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  shutter?: number; // seconds
  focalLength?: number;
  dateTaken?: string; // ISO
  gps?: { lat: number; lon: number; alt?: number } | null;
  orientation?: number;
  width?: number;
  height?: number;
}

export interface IptcMeta {
  title?: string;
  caption?: string;
  creator?: string;
  copyright?: string;
  location?: string;
}

export interface Photo {
  id: number;
  path: string;
  filename: string;
  folder: string;
  ext: string;
  isRaw: boolean;
  fileSize: number;
  hash: string;
  width: number;
  height: number;
  exif: PhotoExif;
  iptc: IptcMeta;
  rating: number; // 0..5
  flag: Flag;
  label: ColorLabel;
  favorite: boolean;
  keywords: string[];
  importedAt: string;
  editedAt: string | null;
  hasEdits: boolean;
  aiEnhanced: boolean;
  presetName: string | null;
  /** Virtual copy: points at the master photo id; null for masters */
  masterId: number | null;
  copyName: string | null;
  thumbState: 'pending' | 'ready' | 'error';
  error: string | null;
  aiTags: string[];
  stackCount?: number;
}

export interface Collection {
  id: number;
  name: string;
  kind: 'collection' | 'album' | 'smart';
  parentId: number | null;
  rules: SmartRuleSet | null;
  count?: number;
}

export interface FolderNode { path: string; name: string; count: number; children: FolderNode[] }

export type SmartField =
  | 'rating' | 'flag' | 'label' | 'camera' | 'lens' | 'iso' | 'aperture' | 'shutter' | 'focalLength'
  | 'date' | 'folder' | 'keyword' | 'fileType' | 'edited' | 'preset' | 'aiEnhanced' | 'orientation'
  | 'filename' | 'aiTag' | 'favorite' | 'isRaw';

export type SmartOp = 'is' | 'isNot' | 'gte' | 'lte' | 'contains' | 'notContains' | 'between';

export interface SmartRule { field: SmartField; op: SmartOp; value: any; value2?: any }
export interface SmartRuleSet { match: 'all' | 'any'; rules: SmartRule[] }

export interface PhotoQuery {
  text?: string;
  folder?: string | null;
  collectionId?: number | null;
  rules?: SmartRuleSet | null;
  sort?: 'date' | 'imported' | 'filename' | 'rating' | 'edited';
  sortDir?: 'asc' | 'desc';
}

export interface Preset {
  id: string;
  name: string;
  folder: string;
  favorite: boolean;
  builtin: boolean;
  groups: SettingGroup[];
  settings: Partial<EditParams>;
  createdAt: string;
  /** Extra info, e.g. reference-grade analysis summary */
  source?: { kind: 'user' | 'builtin' | 'reference-grade' | 'ai'; note?: string };
}

export interface HistoryEntry {
  id: number;
  photoId: number;
  label: string;
  edit: EditParams;
  createdAt: string;
}

export interface Snapshot { id: number; photoId: number; name: string; edit: EditParams; createdAt: string }

export interface ImportOptions {
  paths: string[];
  recursive: boolean;
  mode: 'reference' | 'copy';
  destination?: string;
  skipDuplicates: boolean;
  keywords?: string[];
  applyPresetId?: string | null;
}

export interface ImportProgress {
  jobId: string;
  phase: 'scanning' | 'importing' | 'thumbnails' | 'done' | 'error';
  total: number;
  done: number;
  imported: number;
  duplicates: number;
  failed: number;
  current?: string;
  message?: string;
}

export type ExportFormat = 'jpeg' | 'png' | 'tiff' | 'dng';
export type ColorSpaceId = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto';

export interface ExportSettings {
  format: ExportFormat;
  quality: number; // 1..100
  bitDepth: 8 | 16;
  resize: { mode: 'none' | 'long' | 'short' | 'width' | 'height' | 'dimensions' | 'megapixels'; width: number; height: number; long: number; megapixels: number; noEnlarge: boolean };
  ppi: number;
  colorSpace: ColorSpaceId;
  metadata: 'all' | 'copyright' | 'none';
  removeLocation: boolean;
  sharpen: { enabled: boolean; target: 'screen' | 'matte' | 'glossy'; amount: 'low' | 'standard' | 'high' };
  filenameTemplate: string;
  destination: string;
  subfolder: string;
  conflict: 'unique' | 'overwrite' | 'skip';
  watermark?: { enabled: boolean; text: string; opacity: number; size: number; position: 'br' | 'bl' | 'tr' | 'tl' | 'center' } | null;
}

export interface ExportPreset { id: string; name: string; builtin: boolean; settings: ExportSettings }

export interface ExportProgress {
  jobId: string; total: number; done: number; failed: number; current?: string; phase: 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled'; message?: string; outputs?: string[];
}

export interface AppSettings {
  general: { language: string; uiScale: number; theme: 'dark' | 'darker' | 'high-contrast'; startup: 'last' | 'library'; confirmDeletes: boolean };
  performance: { gpu: boolean; cacheSizeMB: number; previewQuality: 'standard' | 'high' | 'full'; previewLongEdge: number; backgroundProcessing: boolean; workerThreads: number };
  catalog: { location: string; backupLocation: string; autoBackup: 'never' | 'daily' | 'weekly' | 'on-exit'; keepBackups: number; lastBackup: string | null; writeXmpSidecars: boolean };
  ai: { provider: 'local' | 'cloud' | 'off'; cloudEndpoint: string; cloudConsent: boolean; analyzeOnImport: boolean; models: Record<string, string> };
  color: { displayProfile: 'srgb' | 'display-p3'; workingSpace: 'rec2020-linear'; softProof: ColorSpaceId | null };
  shortcuts: Record<string, string>;
  panels: Record<string, any>;
  onboarding: { demoLoaded: boolean };
}

export interface CatalogStats { photos: number; raw: number; edited: number; picks: number; rejects: number; sizeBytes: number }

export interface BackupInfo { path: string; createdAt: string; sizeBytes: number }

export interface LensProfile {
  id: string; make: string; model: string; mount?: string;
  /** Polynomial radial distortion (PTLens a,b,c), indexed by focal length */
  distortion: { focal: number; a: number; b: number; c: number }[];
  /** Vignetting k1..k3 per focal/aperture */
  vignetting: { focal: number; aperture: number; k1: number; k2: number; k3: number }[];
  /** Lateral chromatic aberration scale factors */
  tca: { focal: number; vr: number; vb: number }[];
  source: string;
}

export interface AiCapability { target: string; available: boolean; engine: 'model' | 'heuristic' | 'none'; detail: string }
