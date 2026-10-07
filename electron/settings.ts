import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../src/shared/types';
import { deepMerge } from '../src/shared/edit';
import { DEFAULT_SHORTCUTS } from '../src/shared/shortcuts';

export function defaultSettings(userData: string, pictures: string): AppSettings {
  return {
    general: { language: 'en', uiScale: 1, theme: 'dark', startup: 'last', confirmDeletes: true },
    performance: { gpu: true, cacheSizeMB: 4096, previewQuality: 'standard', previewLongEdge: 2560, backgroundProcessing: true, workerThreads: 2 },
    catalog: { location: path.join(userData, 'Catalog'), backupLocation: path.join(userData, 'Backups'), autoBackup: 'weekly', keepBackups: 10, lastBackup: null, writeXmpSidecars: false },
    ai: { provider: 'local', cloudEndpoint: '', cloudConsent: false, analyzeOnImport: true, models: {} },
    color: { displayProfile: 'srgb', workingSpace: 'rec2020-linear', softProof: null },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    panels: {},
    onboarding: { demoLoaded: false },
  } as AppSettings & { managedLibrary?: string };
}

export class SettingsStore {
  private file: string;
  data: AppSettings;
  constructor(userData: string, pictures: string) {
    this.file = path.join(userData, 'settings.json');
    const defaults = defaultSettings(userData, pictures);
    let loaded: Partial<AppSettings> = {};
    try { loaded = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = deepMerge(defaults, loaded);
  }
  update(patch: Partial<AppSettings>): AppSettings {
    this.data = deepMerge(this.data, patch);
    // Shortcuts and panels are replaced wholesale so removed keys don't linger.
    if (patch.shortcuts) this.data.shortcuts = { ...patch.shortcuts };
    this.save();
    return this.data;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
