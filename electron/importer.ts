import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Catalog } from './catalog';
import type { PreviewCache } from './media';
import { quickHash } from './media';
import { readMetadata } from './metadata';
import { formatFor, isSupported } from '../src/shared/formats';
import type { ImportOptions, ImportProgress, PhotoExif } from '../src/shared/types';

export interface RawThumbResult { angle?: number; jpeg?: Uint8Array; rgb?: { width: number; height: number; data: Uint8Array }; width?: number; height?: number; exif?: Partial<PhotoExif>; error?: string }
export type RawThumbProvider = (id: number, file: string) => Promise<RawThumbResult>;

/** Recursively (optionally) list supported image files under the given paths. */
export async function scanPaths(paths: string[], recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (p: string, depth: number) => {
    let st: fs.Stats;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 0 && !recursive) return;
      let entries: fs.Dirent[] = [];
      try { entries = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        await visit(path.join(p, e.name), depth + 1);
      }
    } else if (st.isFile() && isSupported(p)) {
      const abs = path.resolve(p);
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  };
  for (const p of paths) await visit(p, 0);
  return out;
}

function uniqueDest(dir: string, name: string) {
  let target = path.join(dir, name);
  const { name: base, ext } = path.parse(name);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base}-${i++}${ext}`);
  return target;
}

export class Importer extends EventEmitter {
  private cancelled = new Set<string>();
  constructor(private catalog: Catalog, private previews: PreviewCache, private rawThumbs: () => RawThumbProvider | null) { super(); }

  cancel(jobId: string) { this.cancelled.add(jobId); }

  async run(jobId: string, opts: ImportOptions): Promise<ImportProgress> {
    const prog: ImportProgress = { jobId, phase: 'scanning', total: 0, done: 0, imported: 0, duplicates: 0, failed: 0 };
    const emit = () => this.emit('progress', { ...prog });
    emit();
    const files = await scanPaths(opts.paths, opts.recursive);
    prog.total = files.length;
    prog.phase = 'importing';
    emit();
    const newIds: { id: number; file: string; raw: boolean }[] = [];

    for (const src of files) {
      if (this.cancelled.has(jobId)) break;
      prog.current = path.basename(src);
      try {
        const st = await fs.promises.stat(src);
        const hash = await quickHash(src, st.size);
        if (this.catalog.findByPath(src) || (opts.skipDuplicates && this.catalog.findByHash(hash))) {
          prog.duplicates++;
        } else {
          let file = src;
          const meta = await readMetadata(src);
          if (opts.mode === 'copy' && opts.destination) {
            const d = meta.exif.dateTaken ? new Date(meta.exif.dateTaken) : st.mtime;
            const y = String(d.getFullYear()), day = d.toISOString().slice(0, 10);
            const dir = path.join(opts.destination, y, day);
            await fs.promises.mkdir(dir, { recursive: true });
            file = uniqueDest(dir, path.basename(src));
            await fs.promises.copyFile(src, file, fs.constants.COPYFILE_EXCL);
          }
          const fmt = formatFor(file)!;
          const id = this.catalog.insertPhoto({
            path: file, filename: path.basename(file), folder: path.dirname(file), ext: fmt.ext, isRaw: fmt.raw,
            fileSize: st.size, hash, width: meta.exif.width ?? 0, height: meta.exif.height ?? 0, exif: meta.exif, iptc: meta.iptc,
          });
          const kws = [...meta.keywords, ...(opts.keywords ?? [])];
          if (kws.length) this.catalog.addKeywords([id], kws);
          newIds.push({ id, file, raw: fmt.raw });
          prog.imported++;
          this.emit('photo-added', id);
        }
      } catch (e: any) {
        prog.failed++;
        prog.message = `${path.basename(src)}: ${e?.message ?? e}`;
      }
      prog.done++;
      emit();
    }

    prog.phase = 'thumbnails';
    prog.done = 0;
    prog.total = newIds.length;
    emit();
    await this.buildThumbnails(newIds, () => { prog.done++; emit(); }, jobId);
    prog.phase = 'done';
    prog.current = undefined;
    emit();
    this.cancelled.delete(jobId);
    return prog;
  }

  /** Generate previews with bounded concurrency. Failures are recorded per photo, never thrown. */
  async buildThumbnails(items: { id: number; file: string; raw: boolean }[], onEach?: () => void, jobId?: string) {
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        if (jobId && this.cancelled.has(jobId)) return;
        const it = items[i++];
        await this.buildOne(it.id, it.file, it.raw);
        onEach?.();
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
  }

  async buildOne(id: number, file: string, raw: boolean) {
    try {
      if (!fs.existsSync(file)) throw new Error('File not found (it may have been moved or the drive disconnected).');
      if (raw) {
        const provider = this.rawThumbs();
        if (!provider) throw new Error('RAW decoder not available.');
        const r = await provider(id, file);
        if (r.error) throw new Error(r.error);
        let dims: { width: number; height: number };
        if (r.jpeg) dims = await this.previews.build(id, Buffer.from(r.jpeg), { angle: r.angle ?? 0 });
        else if (r.rgb) {
          const sharp = (await import('sharp')).default;
          const jpeg = await sharp(Buffer.from(r.rgb.data), { raw: { width: r.rgb.width, height: r.rgb.height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
          dims = await this.previews.build(id, jpeg, { angle: 0 });
        } else throw new Error('No preview data returned');
        this.catalog.updateDecodedInfo(id, { width: r.width || dims.width, height: r.height || dims.height, exif: r.exif, thumbState: 'ready', error: null });
      } else {
        const dims = await this.previews.build(id, file);
        this.catalog.updateDecodedInfo(id, { width: dims.width, height: dims.height, thumbState: 'ready', error: null });
      }
    } catch (e: any) {
      this.catalog.setThumbState(id, 'error', String(e?.message ?? e));
    }
    this.emit('photo-updated', id);
  }
}
