import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import type { Collection, FolderNode, HistoryEntry, Photo, PhotoQuery, Preset, Snapshot, SmartRule, SmartRuleSet, CatalogStats, ExportPreset } from '../src/shared/types';
import { normalizeEdit, isEdited, type EditParams } from '../src/shared/edit';

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  folder TEXT NOT NULL,
  ext TEXT NOT NULL,
  is_raw INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  exif TEXT NOT NULL DEFAULT '{}',
  iptc TEXT NOT NULL DEFAULT '{}',
  camera TEXT, lens TEXT, iso REAL, aperture REAL, shutter REAL, focal REAL,
  date_taken TEXT, orientation TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  flag TEXT NOT NULL DEFAULT 'none',
  label TEXT NOT NULL DEFAULT 'none',
  favorite INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  edited_at TEXT,
  edit TEXT,
  has_edits INTEGER NOT NULL DEFAULT 0,
  ai_enhanced INTEGER NOT NULL DEFAULT 0,
  preset_name TEXT,
  master_id INTEGER REFERENCES photos(id) ON DELETE CASCADE,
  copy_name TEXT,
  thumb_state TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  ai_tags TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS photos_path_master ON photos(path) WHERE master_id IS NULL;
CREATE INDEX IF NOT EXISTS photos_hash ON photos(hash);
CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder);
CREATE INDEX IF NOT EXISTS photos_date ON photos(date_taken);
CREATE TABLE IF NOT EXISTS keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS photo_keywords (photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE, PRIMARY KEY (photo_id, keyword_id));
CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, parent_id INTEGER, rules TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_photos (collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, PRIMARY KEY (collection_id, photo_id));
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, label TEXT NOT NULL, edit TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_photo ON history(photo_id);
CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, name TEXT NOT NULL, edit TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0, groups TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT);
CREATE TABLE IF NOT EXISTS export_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL);
`;

const now = () => new Date().toISOString();

export class Catalog {
  db: DatabaseSync;
  readonly file: string;
  private stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate() {
    const v = Number(this.getMeta('schema_version') ?? 0);
    if (v < SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  close() { this.db.close(); }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getMeta(key: string): string | undefined { return (this.q('SELECT value FROM meta WHERE key=?').get(key) as any)?.value; }
  setMeta(key: string, value: string) { this.q('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }

  /* ---------------------------------------------------------------- photos */

  findByHash(hash: string): number | undefined { return (this.q('SELECT id FROM photos WHERE hash=? AND master_id IS NULL LIMIT 1').get(hash) as any)?.id; }
  findByPath(p: string): number | undefined { return (this.q('SELECT id FROM photos WHERE path=? AND master_id IS NULL').get(p) as any)?.id; }

  insertPhoto(p: Omit<Photo, 'id' | 'rating' | 'flag' | 'label' | 'favorite' | 'keywords' | 'editedAt' | 'hasEdits' | 'aiEnhanced' | 'presetName' | 'masterId' | 'copyName' | 'thumbState' | 'error' | 'aiTags' | 'importedAt' | 'iptc'> & { iptc?: Photo['iptc'] }): number {
    const e = p.exif;
    const orientation = p.width && p.height ? (p.width > p.height ? 'landscape' : p.width < p.height ? 'portrait' : 'square') : null;
    const r = this.q(`INSERT INTO photos (path, filename, folder, ext, is_raw, file_size, hash, width, height, exif, iptc, camera, lens, iso, aperture, shutter, focal, date_taken, orientation, imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      p.path, p.filename, p.folder, p.ext, p.isRaw ? 1 : 0, p.fileSize, p.hash, p.width, p.height, JSON.stringify(e), JSON.stringify(p.iptc ?? {}),
      [e.make, e.model].filter(Boolean).join(' ').trim() || null, e.lens ?? null, e.iso ?? null, e.aperture ?? null, e.shutter ?? null, e.focalLength ?? null,
      e.dateTaken ?? null, orientation, now());
    return Number(r.lastInsertRowid);
  }

  updateDecodedInfo(id: number, info: { width?: number; height?: number; exif?: Partial<Photo['exif']>; thumbState?: Photo['thumbState']; error?: string | null }) {
    const cur = this.getPhoto(id);
    if (!cur) return;
    // Decoder-provided metadata only fills gaps left by the EXIF reader.
    const exif = { ...(info.exif ?? {}), ...cur.exif };
    for (const k of Object.keys(exif) as (keyof typeof exif)[]) if (exif[k] === undefined || exif[k] === null || (exif[k] as any) === '') delete exif[k];
    const width = info.width || cur.width, height = info.height || cur.height;
    const orientation = width && height ? (width > height ? 'landscape' : width < height ? 'portrait' : 'square') : null;
    this.q(`UPDATE photos SET width=?, height=?, exif=?, camera=?, lens=?, iso=?, aperture=?, shutter=?, focal=?, date_taken=?, orientation=?, thumb_state=?, error=? WHERE id=? OR master_id=?`).run(
      width, height, JSON.stringify(exif), [exif.make, exif.model].filter(Boolean).join(' ').trim() || null, exif.lens ?? null, exif.iso ?? null,
      exif.aperture ?? null, exif.shutter ?? null, exif.focalLength ?? null, exif.dateTaken ?? null, orientation,
      info.thumbState ?? cur.thumbState, info.error === undefined ? cur.error : info.error, id, id);
  }

  setThumbState(id: number, state: Photo['thumbState'], error: string | null = null) {
    this.q('UPDATE photos SET thumb_state=?, error=? WHERE id=? OR master_id=?').run(state, error, id, id);
  }

  private rowToPhoto = (r: any): Photo => ({
    id: r.id, path: r.path, filename: r.filename, folder: r.folder, ext: r.ext, isRaw: !!r.is_raw, fileSize: r.file_size, hash: r.hash,
    width: r.width, height: r.height, exif: JSON.parse(r.exif), iptc: JSON.parse(r.iptc), rating: r.rating, flag: r.flag, label: r.label,
    favorite: !!r.favorite, keywords: r.kw ? String(r.kw).split('\u001f') : [], importedAt: r.imported_at, editedAt: r.edited_at,
    hasEdits: !!r.has_edits, aiEnhanced: !!r.ai_enhanced, presetName: r.preset_name, masterId: r.master_id, copyName: r.copy_name,
    thumbState: r.thumb_state, error: r.error, aiTags: JSON.parse(r.ai_tags || '[]'),
  });

  private photoSelect = `SELECT p.*, (SELECT group_concat(k.name, char(31)) FROM photo_keywords pk JOIN keywords k ON k.id=pk.keyword_id WHERE pk.photo_id=p.id) AS kw FROM photos p`;

  getPhoto(id: number): Photo | undefined {
    const r = this.q(`${this.photoSelect} WHERE p.id=?`).get(id);
    return r ? this.rowToPhoto(r) : undefined;
  }

  getPhotos(ids: number[]): Photo[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`${this.photoSelect} WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const map = new Map(rows.map((r: any) => [r.id, this.rowToPhoto(r)]));
    return ids.map(i => map.get(i)!).filter(Boolean);
  }

  queryPhotos(query: PhotoQuery): Photo[] {
    const where: string[] = [];
    const args: any[] = [];
    if (query.folder) { where.push('(p.folder = ? OR p.folder LIKE ?)'); args.push(query.folder, query.folder.replace(/[\\/]+$/, '') + path.sep + '%'); }
    if (query.collectionId) {
      const col = this.getCollection(query.collectionId);
      if (col?.kind === 'smart' && col.rules) { const c = this.rulesToSql(col.rules); if (c.sql) { where.push(c.sql); args.push(...c.args); } }
      else { where.push('p.id IN (SELECT photo_id FROM collection_photos WHERE collection_id=?)'); args.push(query.collectionId); }
    }
    if (query.rules?.rules.length) { const c = this.rulesToSql(query.rules); if (c.sql) { where.push(c.sql); args.push(...c.args); } }
    if (query.text?.trim()) {
      for (const term of query.text.trim().split(/\s+/)) {
        const like = `%${term}%`;
        where.push(`(p.filename LIKE ? OR p.camera LIKE ? OR p.lens LIKE ? OR p.iptc LIKE ? OR p.ai_tags LIKE ? OR p.folder LIKE ? OR p.preset_name LIKE ? OR p.copy_name LIKE ?
          OR p.id IN (SELECT pk.photo_id FROM photo_keywords pk JOIN keywords k ON k.id=pk.keyword_id WHERE k.name LIKE ?))`);
        args.push(like, like, like, like, like, like, like, like, like);
      }
    }
    const sortCol = { date: "COALESCE(p.date_taken, p.imported_at)", imported: 'p.imported_at', filename: 'p.filename COLLATE NOCASE', rating: 'p.rating', edited: 'COALESCE(p.edited_at, \'\')' }[query.sort ?? 'date'];
    const dir = query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const sql = `${this.photoSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sortCol} ${dir}, p.filename ASC, p.id ASC`;
    return this.db.prepare(sql).all(...args).map(this.rowToPhoto);
  }

  /** Translate smart-collection / filter rules into SQL. Exported for tests. */
  rulesToSql(set: SmartRuleSet): { sql: string; args: any[] } {
    const parts: string[] = [];
    const args: any[] = [];
    for (const r of set.rules) {
      const c = this.ruleToSql(r);
      if (c) { parts.push(c.sql); args.push(...c.args); }
    }
    if (!parts.length) return { sql: '', args: [] };
    return { sql: '(' + parts.join(set.match === 'any' ? ' OR ' : ' AND ') + ')', args };
  }

  private ruleToSql(r: SmartRule): { sql: string; args: any[] } | null {
    const col: Record<string, string> = {
      rating: 'p.rating', flag: 'p.flag', label: 'p.label', camera: 'p.camera', lens: 'p.lens', iso: 'p.iso', aperture: 'p.aperture',
      shutter: 'p.shutter', focalLength: 'p.focal', date: 'p.date_taken', folder: 'p.folder', fileType: 'p.ext', edited: 'p.has_edits',
      preset: 'p.preset_name', aiEnhanced: 'p.ai_enhanced', orientation: 'p.orientation', filename: 'p.filename', favorite: 'p.favorite', isRaw: 'p.is_raw',
    };
    if (r.field === 'keyword') {
      const sub = 'p.id IN (SELECT pk.photo_id FROM photo_keywords pk JOIN keywords k ON k.id=pk.keyword_id WHERE k.name LIKE ?)';
      const v = r.op === 'is' || r.op === 'isNot' ? String(r.value) : `%${r.value}%`;
      return { sql: r.op === 'isNot' || r.op === 'notContains' ? `NOT (${sub})` : sub, args: [v] };
    }
    if (r.field === 'aiTag') {
      // Scene tags match AI analysis results or user keywords.
      const sub = `(p.ai_tags LIKE ? OR p.id IN (SELECT pk.photo_id FROM photo_keywords pk JOIN keywords k ON k.id=pk.keyword_id WHERE k.name LIKE ?))`;
      const args = [`%"${r.value}%`, `%${r.value}%`];
      return { sql: r.op === 'isNot' || r.op === 'notContains' ? `NOT ${sub}` : sub, args };
    }
    const c = col[r.field];
    if (!c) return null;
    let v = r.value;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    switch (r.op) {
      case 'is': return typeof v === 'string' && ['camera', 'lens', 'fileType', 'preset'].includes(r.field) ? { sql: `${c} = ? COLLATE NOCASE`, args: [v] } : { sql: `${c} = ?`, args: [v] };
      case 'isNot': return { sql: `(${c} IS NULL OR ${c} != ?)`, args: [v] };
      case 'gte': return { sql: `${c} >= ?`, args: [v] };
      case 'lte': return { sql: `${c} <= ?`, args: [v] };
      case 'between': return { sql: `${c} BETWEEN ? AND ?`, args: [v, r.value2] };
      case 'contains': return { sql: `${c} LIKE ?`, args: [`%${v}%`] };
      case 'notContains': return { sql: `(${c} IS NULL OR ${c} NOT LIKE ?)`, args: [`%${v}%`] };
    }
    return null;
  }

  distinctValues(): { cameras: string[]; lenses: string[]; exts: string[]; presets: string[]; keywords: string[]; aiTags: string[] } {
    const col = (sql: string) => this.db.prepare(sql).all().map((r: any) => r.v).filter(Boolean);
    const tags = new Set<string>();
    for (const r of this.db.prepare("SELECT ai_tags v FROM photos WHERE ai_tags != '[]'").all() as any[]) for (const t of JSON.parse(r.v)) tags.add(t);
    return {
      cameras: col('SELECT DISTINCT camera v FROM photos ORDER BY v'),
      lenses: col('SELECT DISTINCT lens v FROM photos ORDER BY v'),
      exts: col('SELECT DISTINCT upper(ext) v FROM photos ORDER BY v'),
      presets: col('SELECT DISTINCT preset_name v FROM photos ORDER BY v'),
      keywords: col('SELECT name v FROM keywords ORDER BY name COLLATE NOCASE'),
      aiTags: [...tags].sort(),
    };
  }

  setRating(ids: number[], rating: number) { this.bulk(ids, 'UPDATE photos SET rating=? WHERE id=?', rating); }
  setFlag(ids: number[], flag: string) { this.bulk(ids, 'UPDATE photos SET flag=? WHERE id=?', flag); }
  setLabel(ids: number[], label: string) { this.bulk(ids, 'UPDATE photos SET label=? WHERE id=?', label); }
  setFavorite(ids: number[], fav: boolean) { this.bulk(ids, 'UPDATE photos SET favorite=? WHERE id=?', fav ? 1 : 0); }
  setIptc(ids: number[], iptc: Partial<Photo['iptc']>) {
    this.tx(() => { for (const id of ids) { const p = this.getPhoto(id); if (p) this.q('UPDATE photos SET iptc=? WHERE id=?').run(JSON.stringify({ ...p.iptc, ...iptc }), id); } });
  }
  setAiTags(id: number, tags: string[]) { this.q('UPDATE photos SET ai_tags=? WHERE id=?').run(JSON.stringify(tags), id); }

  private bulk(ids: number[], sql: string, v: any) { this.tx(() => { for (const id of ids) this.q(sql).run(v, id); }); }

  addKeywords(ids: number[], words: string[]) {
    this.tx(() => {
      for (const w of words.map(s => s.trim()).filter(Boolean)) {
        this.q('INSERT OR IGNORE INTO keywords(name) VALUES(?)').run(w);
        const kid = (this.q('SELECT id FROM keywords WHERE name=?').get(w) as any).id;
        for (const id of ids) this.q('INSERT OR IGNORE INTO photo_keywords(photo_id, keyword_id) VALUES(?,?)').run(id, kid);
      }
    });
  }
  removeKeyword(ids: number[], word: string) {
    const kid = (this.q('SELECT id FROM keywords WHERE name=?').get(word) as any)?.id;
    if (!kid) return;
    this.tx(() => { for (const id of ids) this.q('DELETE FROM photo_keywords WHERE photo_id=? AND keyword_id=?').run(id, kid); });
  }

  /** Remove from catalog only — never deletes files on disk. */
  removePhotos(ids: number[]) { this.tx(() => { for (const id of ids) this.q('DELETE FROM photos WHERE id=?').run(id); }); }

  folderTree(): FolderNode[] {
    const rows = this.db.prepare('SELECT folder, count(*) c FROM photos WHERE master_id IS NULL GROUP BY folder').all() as any[];
    // Group by import roots: build a trie and collapse single-child chains.
    const root: FolderNode = { path: '', name: '', count: 0, children: [] };
    for (const r of rows) {
      const parts = String(r.folder).split(/[\\/]/).filter(Boolean);
      let node = root;
      let acc = String(r.folder).startsWith('/') ? '' : '';
      for (let i = 0; i < parts.length; i++) {
        acc = i === 0 ? (String(r.folder).startsWith('/') ? '/' + parts[0] : parts[0]) : acc + path.sep + parts[i];
        let child = node.children.find(c => c.name === parts[i]);
        if (!child) { child = { path: acc, name: parts[i], count: 0, children: [] }; node.children.push(child); }
        child.count += r.c;
        node = child;
      }
    }
    const direct = new Set(rows.map(r => String(r.folder)));
    const collapse = (n: FolderNode): FolderNode => {
      while (n.children.length === 1 && !direct.has(n.path)) {
        const c = n.children[0];
        n = { ...c, name: n.name + path.sep + c.name };
      }
      return { ...n, children: n.children.map(collapse).sort((a, b) => a.name.localeCompare(b.name)) };
    };
    return root.children.map(collapse).sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ----------------------------------------------------------------- edits */

  getEdit(id: number): EditParams | null {
    const r = this.q('SELECT edit, is_raw FROM photos WHERE id=?').get(id) as any;
    if (!r) return null;
    return r.edit ? normalizeEdit(JSON.parse(r.edit), !!r.is_raw) : null;
  }

  /** Persist an edit; returns the new history entry id when a label is given. */
  saveEdit(id: number, edit: EditParams, opts: { historyLabel?: string; presetName?: string | null; aiEnhanced?: boolean } = {}): number | null {
    const r = this.q('SELECT is_raw FROM photos WHERE id=?').get(id) as any;
    if (!r) return null;
    let hid: number | null = null;
    const edited = isEdited(edit, !!r.is_raw);
    this.tx(() => {
      this.q('UPDATE photos SET edit=?, has_edits=?, edited_at=? WHERE id=?').run(JSON.stringify(edit), edited ? 1 : 0, now(), id);
      if (opts.presetName !== undefined) this.q('UPDATE photos SET preset_name=? WHERE id=?').run(opts.presetName, id);
      if (opts.aiEnhanced !== undefined) this.q('UPDATE photos SET ai_enhanced=? WHERE id=?').run(opts.aiEnhanced ? 1 : 0, id);
      if (opts.historyLabel) hid = Number(this.q('INSERT INTO history(photo_id,label,edit,created_at) VALUES(?,?,?,?)').run(id, opts.historyLabel, JSON.stringify(edit), now()).lastInsertRowid);
    });
    return hid;
  }

  getHistory(id: number): HistoryEntry[] {
    return (this.q('SELECT * FROM history WHERE photo_id=? ORDER BY id ASC').all(id) as any[]).map(r => ({ id: r.id, photoId: r.photo_id, label: r.label, edit: JSON.parse(r.edit), createdAt: r.created_at }));
  }
  /** Truncate history after a given entry (used when the user branches after undo). */
  truncateHistory(id: number, afterEntryId: number) { this.q('DELETE FROM history WHERE photo_id=? AND id>?').run(id, afterEntryId); }
  clearHistory(id: number) { this.q('DELETE FROM history WHERE photo_id=?').run(id); }

  getSnapshots(id: number): Snapshot[] {
    return (this.q('SELECT * FROM snapshots WHERE photo_id=? ORDER BY id DESC').all(id) as any[]).map(r => ({ id: r.id, photoId: r.photo_id, name: r.name, edit: JSON.parse(r.edit), createdAt: r.created_at }));
  }
  addSnapshot(id: number, name: string, edit: EditParams) { this.q('INSERT INTO snapshots(photo_id,name,edit,created_at) VALUES(?,?,?,?)').run(id, name, JSON.stringify(edit), now()); }
  deleteSnapshot(sid: number) { this.q('DELETE FROM snapshots WHERE id=?').run(sid); }

  createVirtualCopy(id: number, name?: string): number {
    const p = this.getPhoto(id);
    if (!p) throw new Error('Photo not found');
    const masterId = p.masterId ?? p.id;
    const n = (this.q('SELECT count(*) c FROM photos WHERE master_id=?').get(masterId) as any).c + 1;
    const r = this.q(`INSERT INTO photos (path, filename, folder, ext, is_raw, file_size, hash, width, height, exif, iptc, camera, lens, iso, aperture, shutter, focal, date_taken, orientation,
        rating, flag, label, imported_at, edit, has_edits, edited_at, master_id, copy_name, thumb_state, ai_tags)
      SELECT path, filename, folder, ext, is_raw, file_size, hash, width, height, exif, iptc, camera, lens, iso, aperture, shutter, focal, date_taken, orientation,
        rating, flag, label, ?, edit, has_edits, edited_at, ?, ?, thumb_state, ai_tags FROM photos WHERE id=?`).run(now(), masterId, name ?? `Copy ${n}`, id);
    const newId = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO photo_keywords(photo_id, keyword_id) SELECT ?, keyword_id FROM photo_keywords WHERE photo_id=?').run(newId, id);
    return newId;
  }

  /* ----------------------------------------------------------- collections */

  getCollections(): Collection[] {
    const rows = this.db.prepare('SELECT c.*, (SELECT count(*) FROM collection_photos cp WHERE cp.collection_id=c.id) n FROM collections c ORDER BY kind, name COLLATE NOCASE').all() as any[];
    return rows.map(r => {
      const rules = r.rules ? JSON.parse(r.rules) : null;
      let count = r.n;
      if (r.kind === 'smart' && rules) { const c = this.rulesToSql(rules); count = (this.db.prepare(`SELECT count(*) n FROM photos p ${c.sql ? 'WHERE ' + c.sql : ''}`).get(...c.args) as any).n; }
      return { id: r.id, name: r.name, kind: r.kind, parentId: r.parent_id, rules, count };
    });
  }
  getCollection(id: number): Collection | undefined { return this.getCollections().find(c => c.id === id); }
  createCollection(name: string, kind: Collection['kind'], rules: SmartRuleSet | null = null, parentId: number | null = null): number {
    return Number(this.q('INSERT INTO collections(name,kind,parent_id,rules,created_at) VALUES(?,?,?,?,?)').run(name, kind, parentId, rules ? JSON.stringify(rules) : null, now()).lastInsertRowid);
  }
  updateCollection(id: number, patch: { name?: string; rules?: SmartRuleSet | null }) {
    if (patch.name !== undefined) this.q('UPDATE collections SET name=? WHERE id=?').run(patch.name, id);
    if (patch.rules !== undefined) this.q('UPDATE collections SET rules=? WHERE id=?').run(patch.rules ? JSON.stringify(patch.rules) : null, id);
  }
  deleteCollection(id: number) { this.q('DELETE FROM collections WHERE id=?').run(id); }
  addToCollection(cid: number, ids: number[]) { this.tx(() => { for (const id of ids) this.q('INSERT OR IGNORE INTO collection_photos VALUES(?,?)').run(cid, id); }); }
  removeFromCollection(cid: number, ids: number[]) { this.tx(() => { for (const id of ids) this.q('DELETE FROM collection_photos WHERE collection_id=? AND photo_id=?').run(cid, id); }); }

  /* --------------------------------------------------------------- presets */

  getPresets(): Preset[] {
    return (this.db.prepare('SELECT * FROM presets ORDER BY builtin DESC, folder, name COLLATE NOCASE').all() as any[]).map(r => ({
      id: r.id, name: r.name, folder: r.folder, favorite: !!r.favorite, builtin: !!r.builtin, groups: JSON.parse(r.groups),
      settings: JSON.parse(r.settings), createdAt: r.created_at, source: r.source ? JSON.parse(r.source) : undefined,
    }));
  }
  savePreset(p: Preset) {
    this.q(`INSERT INTO presets(id,name,folder,favorite,builtin,groups,settings,created_at,source) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, folder=excluded.folder, favorite=excluded.favorite, groups=excluded.groups, settings=excluded.settings, source=excluded.source`)
      .run(p.id, p.name, p.folder, p.favorite ? 1 : 0, p.builtin ? 1 : 0, JSON.stringify(p.groups), JSON.stringify(p.settings), p.createdAt, p.source ? JSON.stringify(p.source) : null);
  }
  deletePreset(id: number | string) { this.q('DELETE FROM presets WHERE id=?').run(String(id)); }
  hasBuiltinPresets(): boolean { return !!(this.q('SELECT 1 FROM presets WHERE builtin=1 LIMIT 1').get()); }

  getExportPresets(): ExportPreset[] {
    return (this.db.prepare('SELECT * FROM export_presets ORDER BY name').all() as any[]).map(r => ({ id: r.id, name: r.name, builtin: false, settings: JSON.parse(r.settings) }));
  }
  saveExportPreset(p: ExportPreset) { this.q('INSERT INTO export_presets(id,name,settings) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, settings=excluded.settings').run(p.id, p.name, JSON.stringify(p.settings)); }
  deleteExportPreset(id: string) { this.q('DELETE FROM export_presets WHERE id=?').run(id); }

  /* ----------------------------------------------------------------- blobs */

  putBlob(key: string, mime: string, data: Uint8Array) { this.q('INSERT INTO blobs(key,mime,data,created_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, mime=excluded.mime').run(key, mime, data, now()); }
  getBlob(key: string): { mime: string; data: Uint8Array } | undefined { const r = this.q('SELECT mime, data FROM blobs WHERE key=?').get(key) as any; return r ? { mime: r.mime, data: r.data } : undefined; }

  stats(): CatalogStats {
    const r = this.db.prepare(`SELECT count(*) photos, sum(is_raw) raw, sum(has_edits) edited, sum(flag='pick') picks, sum(flag='reject') rejects, sum(file_size) size FROM photos WHERE master_id IS NULL`).get() as any;
    return { photos: r.photos ?? 0, raw: r.raw ?? 0, edited: r.edited ?? 0, picks: r.picks ?? 0, rejects: r.rejects ?? 0, sizeBytes: r.size ?? 0 };
  }

  /** Consistent online backup of the catalog file. */
  backupTo(dest: string) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }
}
