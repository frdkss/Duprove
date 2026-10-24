import { DatabaseSync } from 'node:sqlite'
import { mkdir, rename, stat, unlink, lstat } from 'node:fs/promises'
import path from 'node:path'
import { PAGE_SIZE, isCatalogRequest, type CatalogInfo, type CatalogRequest, type FileGroup, type GroupMember, type GroupKind } from '../../contracts/catalog'
import { inspectLocalFile } from './local-file-service'

export const CATALOG_BYTES = 128 * 1024 * 1024
export const CATALOG_AGE = 30 * 24 * 60 * 60 * 1000
type Row = Record<string, any>
// This service runs in the analysis worker. SQL and filesystem paths never cross IPC from the renderer.
export class CatalogService {
  readonly file: string
  constructor(readonly directory: string, readonly executable?: string,
    private readonly inspector: typeof inspectLocalFile = inspectLocalFile) { this.file = path.join(directory, 'results', 'catalog.sqlite') }
  async capture(source: string, analysisId: string, roots: string[], complete: boolean): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = this.file + '.new'
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e })
    const db = new DatabaseSync(temporary)
    try {
      db.exec('PRAGMA page_size=4096; PRAGMA max_page_count=32768; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096;')
      db.prepare('ATTACH DATABASE ? AS source').run(source)
      db.exec(`BEGIN;
        CREATE TABLE meta(analysis_id TEXT,created_at INTEGER,complete INTEGER,roots TEXT);
        CREATE TABLE groups(id TEXT PRIMARY KEY,kind TEXT,count INTEGER,bytes INTEGER,original_id INTEGER);
        CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT UNIQUE,root INTEGER,size INTEGER,mtime TEXT,ctime TEXT,identity TEXT,hash TEXT,decision TEXT DEFAULT 'unresolved');
        CREATE TABLE members(group_id TEXT,file_id INTEGER,PRIMARY KEY(group_id,file_id));
        CREATE INDEX ix_member_file ON members(file_id,group_id);
        CREATE TABLE previews(group_id TEXT,file_id INTEGER,sha256 TEXT,PRIMARY KEY(group_id,file_id));
        INSERT INTO groups SELECT 'e:'||gid,'exact',count(*),sum(size),NULL FROM source.files WHERE gid>0 GROUP BY gid HAVING count(*)>1;
        INSERT INTO members SELECT 'e:'||f.gid,f.rowid FROM source.files f JOIN groups g ON g.id='e:'||f.gid;`)
      const hasContent = db.prepare("SELECT 1 FROM source.sqlite_master WHERE type='table' AND name='content_matches'").get()
      if (hasContent) db.exec(`
        INSERT INTO groups SELECT (CASE m.kind WHEN 'text' THEN 't:' ELSE 'i:' END)||m.rowid,
          CASE m.kind WHEN 'text' THEN 'warn_text' ELSE 'warn_image' END,2,a.size+b.size,NULL
          FROM source.content_matches m JOIN source.files a ON a.path=m.left_path JOIN source.files b ON b.path=m.right_path
          JOIN source.content_files ca ON ca.path=a.path JOIN source.content_files cb ON cb.path=b.path
          WHERE ca.status='ready' AND cb.status='ready' AND m.kind IN ('text','image');
        INSERT INTO members SELECT g.id,f.rowid FROM source.content_matches m JOIN groups g ON g.id=(CASE m.kind WHEN 'text' THEN 't:' ELSE 'i:' END)||m.rowid
          JOIN source.files f ON f.path=m.left_path OR f.path=m.right_path;`)
      db.exec(`INSERT INTO files(id,path,root,size,mtime,ctime,identity,hash)
        SELECT rowid,path,root,size,CAST(mtime AS TEXT),CAST(ctime AS TEXT),identity,hash FROM source.files
        WHERE rowid IN (SELECT file_id FROM members);`)
      db.prepare('INSERT INTO meta VALUES(?,?,?,?)').run(analysisId, Date.now(), complete ? 1 : 0, JSON.stringify(roots))
      db.exec('COMMIT; DETACH DATABASE source;')
      db.close()
      if ((await stat(temporary)).size > CATALOG_BYTES) throw Error('CATALOG_LIMIT')
      await rename(temporary, this.file)
    } catch {
      try { db.close() } catch { /* already closed */ }
      await unlink(temporary).catch(() => {})
      throw Error('CATALOG_SAVE_FAILED')
    }
  }
  async open(analysisId: string): Promise<DatabaseSync> {
    try {
      if ((await stat(this.file)).size > CATALOG_BYTES) throw Error()
    } catch { throw Error('CATALOG_UNAVAILABLE') }
    const db = new DatabaseSync(this.file)
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA busy_timeout=1000;')
      db.exec('CREATE TABLE IF NOT EXISTS previews(group_id TEXT,file_id INTEGER,sha256 TEXT,PRIMARY KEY(group_id,file_id));')
      const meta = db.prepare('SELECT * FROM meta').get() as Row | undefined
      if (!meta) throw Error('CATALOG_UNAVAILABLE')
      if (Date.now() - meta.created_at > CATALOG_AGE) {
        db.close(); await unlink(this.file); throw Error('CATALOG_EXPIRED')
      }
      if (meta.analysis_id !== analysisId) throw Error('CATALOG_UNAVAILABLE')
      return db
    } catch (e) { try { db.close() } catch { /* closed */ }; throw e }
  }
  async request(value: unknown): Promise<unknown> {
    if (!isCatalogRequest(value)) throw Error('INVALID_CATALOG_REQUEST')
    const db = await this.open(value.analysisId)
    try { return await this.read(db, value) } finally { db.close() }
  }
  private async read(db: DatabaseSync, request: CatalogRequest) {
    if (request.action === 'compare' || request.action === 'decision') {
      const group = db.prepare('SELECT * FROM groups WHERE id=?').get(request.groupId) as Row | undefined
      const file = db.prepare('SELECT f.* FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? AND f.id=?').get(request.groupId, request.fileId) as Row | undefined
      if (!group || !file || file.decision === 'trashed') throw Error('FILE_UNAVAILABLE')
      if (request.action === 'decision') {
        if (request.decision === 'delete') {
          if (db.prepare('SELECT 1 FROM groups WHERE original_id=?').get(file.id)) throw Error('ORIGINAL_PROTECTED')
          if (!group.original_id) throw Error('ORIGINAL_REQUIRED')
          if (group.kind !== 'exact' && (!request.reviewed || !db.prepare('SELECT 1 FROM previews WHERE group_id=? AND file_id=?').get(group.id, file.id)
            || !db.prepare('SELECT 1 FROM previews WHERE group_id=? AND file_id=?').get(group.id, group.original_id))) throw Error('MANUAL_REVIEW_REQUIRED')
        }
        db.prepare('UPDATE files SET decision=? WHERE id=?').run(request.decision, file.id)
        return { decision: request.decision }
      }
      if (!group.original_id || group.original_id === file.id) throw Error('ORIGINAL_REQUIRED')
      if (!this.executable) throw Error('FILE_HELPER_UNAVAILABLE')
      const original = db.prepare('SELECT * FROM files WHERE id=?').get(group.original_id) as Row
      db.prepare('DELETE FROM previews WHERE group_id=?').run(group.id)
      const preview = async (entry: Row) => {
        const value = await this.inspect(db, entry, 'preview')
        if (value.status === 'ready') db.prepare('INSERT OR REPLACE INTO previews VALUES(?,?,?)').run(group.id, entry.id, value.sha256!)
        const { sha256: _hash, ...display } = value
        return { ...display, kind: display.kind ?? 'none', id: entry.id, path: entry.path }
      }
      return { original: await preview(original), candidate: await preview(file) }
    }
    if (request.action === 'original') {
      if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(request.groupId)) throw Error('GROUP_UNAVAILABLE')
      if (request.fileId !== null && !db.prepare(`SELECT 1 FROM members m JOIN files f ON f.id=m.file_id
        WHERE m.group_id=? AND f.id=? AND f.decision<>'trashed'`).get(request.groupId, request.fileId)) throw Error('FILE_UNAVAILABLE')
      db.prepare('UPDATE groups SET original_id=? WHERE id=?').run(request.fileId, request.groupId)
      db.prepare('DELETE FROM previews WHERE group_id=?').run(request.groupId)
      if (request.fileId !== null) db.prepare("UPDATE files SET decision='keep' WHERE id=?").run(request.fileId)
      return { originalId: request.fileId }
    }
    if (request.action === 'info') {
      const meta = db.prepare('SELECT * FROM meta').get() as Row
      const groups: Record<GroupKind, number> = { exact: 0, warn_text: 0, warn_image: 0 }
      for (const row of db.prepare('SELECT kind,count(*) AS n FROM groups GROUP BY kind').all() as Row[]) groups[row.kind as GroupKind] = row.n
      return { analysisId: meta.analysis_id, createdAt: meta.created_at, complete: !!meta.complete, groups,
        files: (db.prepare('SELECT count(*) AS n FROM files').get() as Row).n, expiresAt: meta.created_at + CATALOG_AGE } satisfies CatalogInfo
    }
    if (request.action === 'groups') {
      const total = (db.prepare('SELECT count(*) AS n FROM groups WHERE kind=?').get(request.kind) as Row).n
      const items = db.prepare('SELECT id,kind,count,bytes,original_id AS originalId FROM groups WHERE kind=? ORDER BY id LIMIT ? OFFSET ?').all(request.kind, PAGE_SIZE, request.offset) as unknown as FileGroup[]
      return { items, total, offset: request.offset, limit: PAGE_SIZE }
    }
    if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(request.groupId)) throw Error('GROUP_UNAVAILABLE')
    const total = (db.prepare('SELECT count(*) AS n FROM members WHERE group_id=?').get(request.groupId) as Row).n
    const rows = db.prepare(`SELECT f.id,f.path,f.size,f.decision,EXISTS(SELECT 1 FROM groups WHERE original_id=f.id) AS protected
      FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? ORDER BY f.id LIMIT ? OFFSET ?`).all(request.groupId, PAGE_SIZE, request.offset) as Row[]
    const items: GroupMember[] = await Promise.all(rows.map(async row => {
      let availability: GroupMember['availability'] = 'available'
      try { const info = await lstat(row.path); if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size) availability = 'changed' }
      catch (error) { availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }
      return { id: row.id, path: row.path, size: row.size, decision: row.decision, protected: !!row.protected, availability }
    }))
    return { items, total, offset: request.offset, limit: PAGE_SIZE }
  }
  async inspect(db: DatabaseSync, file: Row, action: 'preview' | 'verify') {
    if (!this.executable) throw Error('FILE_HELPER_UNAVAILABLE')
    const meta = db.prepare('SELECT roots FROM meta').get() as Row
    return this.inspector(this.executable, { action, path: file.path, identity: file.identity, size: file.size,
      mtime: file.mtime, ctime: file.ctime, roots: JSON.parse(meta.roots), private_directory: this.directory })
  }
}
