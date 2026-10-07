import fs from 'node:fs';
import path from 'node:path';
import type { Catalog } from './catalog';
import type { BackupInfo } from '../src/shared/types';

const PREFIX = 'lumora-catalog-';

export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(PREFIX) && f.endsWith('.lcat'))
    .map(f => { const p = path.join(dir, f); const st = fs.statSync(p); return { path: p, createdAt: st.mtime.toISOString(), sizeBytes: st.size }; })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createBackup(catalog: Catalog, dir: string, keep: number): BackupInfo {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(dir, `${PREFIX}${stamp}.lcat`);
  catalog.backupTo(dest);
  // Rotate: keep the newest `keep` backups. Only files we created (by prefix) are ever removed.
  const all = listBackups(dir);
  for (const old of all.slice(Math.max(1, keep))) fs.rmSync(old.path, { force: true });
  const st = fs.statSync(dest);
  return { path: dest, createdAt: st.mtime.toISOString(), sizeBytes: st.size };
}

export function isBackupDue(last: string | null, policy: 'never' | 'daily' | 'weekly' | 'on-exit', now = Date.now()): boolean {
  if (policy === 'never') return false;
  if (policy === 'on-exit') return true;
  if (!last) return true;
  const age = now - new Date(last).getTime();
  return age >= (policy === 'daily' ? 864e5 : 7 * 864e5);
}

/**
 * Restoring replaces the catalog file. The current catalog is first saved as a
 * safety backup so restoring can never silently destroy edits.
 */
export function restoreBackup(catalog: Catalog, backupFile: string, backupDir: string): string {
  const safety = path.join(backupDir, `${PREFIX}before-restore-${Date.now()}.lcat`);
  catalog.backupTo(safety);
  const target = catalog.file;
  catalog.close();
  for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
  fs.copyFileSync(backupFile, target);
  return safety;
}
