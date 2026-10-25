import { DatabaseSync } from 'node:sqlite'
import { mkdir, rename, stat, unlink, lstat, readdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { PAGE_SIZE, isCatalogRequest, isTrashRequest, exactKeys, idValid, type CatalogInfo, type CatalogRequest, type FileGroup, type GroupMember, type GroupKind, type TrashPlan } from '../../contracts/catalog'
import { inspectLocalFile } from './local-file-service'
import { randomUUID } from 'node:crypto'
import { object } from '../../contracts/analysis'
import { isComparisonRequest, isComparisonFileRequest, type ComparisonContext, type ComparisonSnapshot } from '../../contracts/comparison'
import WordExtractor from 'word-extractor'
import { fileGuard } from './file-guard'
import { groupSearch, groupSelection } from '../../contracts/group-filters'

export const CATALOG_BYTES = 128 * 1024 * 1024
export const CATALOG_AGE = 30 * 24 * 60 * 60 * 1000
type Row = Record<string, any>
interface LeaseEntry { file: Row; original: Row; kind: GroupKind; verified?: { left: string; right: string } }
// This service runs in the analysis worker. SQL and filesystem paths never cross IPC from the renderer.
export class CatalogService {
  private lease: { token: string; analysisId: string; groupId: string; entries: Map<number, LeaseEntry> } | null = null
  get locked() { return this.lease !== null }
  readonly file: string
  constructor(readonly directory: string, readonly executable?: string,
    private readonly inspector: typeof inspectLocalFile = inspectLocalFile) { this.file = path.join(directory, 'results', 'catalog.sqlite') }
  async capture(source: string, analysisId: string, roots: string[], complete: boolean): Promise<void> {
    if (this.locked) throw Error('CATALOG_BUSY')
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
        CREATE TABLE trash_attempts(file_id INTEGER PRIMARY KEY,state TEXT);
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
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA busy_timeout=1000; PRAGMA max_page_count=32768;')
      db.exec('CREATE TABLE IF NOT EXISTS previews(group_id TEXT,file_id INTEGER,sha256 TEXT,PRIMARY KEY(group_id,file_id));')
      db.exec('CREATE TABLE IF NOT EXISTS trash_attempts(file_id INTEGER PRIMARY KEY,state TEXT);')
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
    if (this.locked) throw Error('CATALOG_BUSY')
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
      const matches = groupSearch(request.query ?? ''), selected = groupSelection(request.filters ?? [])
      db.function('catalog_filename', { deterministic: true }, value => typeof value === 'string' ? path.basename(value) : '')
      db.exec(`CREATE TABLE IF NOT EXISTS group_names(group_id TEXT PRIMARY KEY,name TEXT NOT NULL);
        INSERT OR IGNORE INTO group_names SELECT g.id,
        (SELECT catalog_filename(f.path) AS filename FROM members m JOIN files f ON f.id=m.file_id
          WHERE m.group_id=g.id GROUP BY filename ORDER BY count(*) DESC,filename COLLATE BINARY ASC LIMIT 1)
        FROM groups g WHERE NOT EXISTS(SELECT 1 FROM group_names n WHERE n.group_id=g.id);`)
      db.function('catalog_matches', { deterministic: true }, name => Number(matches(String(name))))
      db.function('catalog_selected', { deterministic: true }, (id, name) => Number(selected(String(id), String(name))))
      const where = 'g.kind=? AND catalog_matches(n.name) AND (?=0 OR catalog_selected(g.id,n.name))'
      const stats = db.prepare(`SELECT count(*) AS total,coalesce(sum(catalog_selected(g.id,n.name)),0) AS selectedTotal
        FROM groups g JOIN group_names n ON n.group_id=g.id WHERE ${where}`).get(request.kind, Number(!!request.selectedOnly)) as Row
      const items = db.prepare(`SELECT g.id,g.kind,g.count,g.bytes,g.original_id AS originalId,n.name
        FROM groups g JOIN group_names n ON n.group_id=g.id WHERE ${where} ORDER BY g.id LIMIT ? OFFSET ?`)
        .all(request.kind, Number(!!request.selectedOnly), PAGE_SIZE, request.offset) as unknown as FileGroup[]
      return { items, ...stats, offset: request.offset, limit: PAGE_SIZE }
    }
    if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(request.groupId)) throw Error('GROUP_UNAVAILABLE')
    const total = (db.prepare('SELECT count(*) AS n FROM members WHERE group_id=?').get(request.groupId) as Row).n
    const rows = db.prepare(`SELECT f.id,f.path,f.size,f.decision,EXISTS(SELECT 1 FROM groups WHERE original_id=f.id) AS protected,
      (SELECT state FROM trash_attempts WHERE file_id=f.id) AS lastOperation
      FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? ORDER BY f.id LIMIT ? OFFSET ?`).all(request.groupId, PAGE_SIZE, request.offset) as Row[]
    const items: GroupMember[] = await Promise.all(rows.map(async row => {
      let availability: GroupMember['availability'] = 'available'
      try { const info = await lstat(row.path); if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size) availability = 'changed' }
      catch (error) { availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }
      return { id: row.id, name: path.basename(row.path), path: row.path, size: row.size, decision: row.decision, protected: !!row.protected, availability, lastOperation: row.lastOperation }
    }))
    return { items, total, offset: request.offset, limit: PAGE_SIZE }
  }
  async inspect(db: DatabaseSync, file: Row, action: 'preview' | 'verify') {
    if (!this.executable) throw Error('FILE_HELPER_UNAVAILABLE')
    const meta = db.prepare('SELECT roots FROM meta').get() as Row
    return this.inspector(this.executable, { action, path: file.path, identity: file.identity, size: file.size,
      mtime: file.mtime, ctime: file.ctime, roots: JSON.parse(meta.roots), private_directory: this.directory })
  }
  private nativeRequest(db: DatabaseSync, file: Row) {
    const meta = db.prepare('SELECT roots FROM meta').get() as Row
    return { path: file.path, identity: file.identity, size: file.size, mtime: file.mtime, ctime: file.ctime,
      roots: JSON.parse(meta.roots), private_directory: this.directory }
  }
  async comparison(value: unknown): Promise<ComparisonContext> {
    if (this.locked) throw Error('CATALOG_BUSY')
    if (!isComparisonRequest(value)) throw Error('INVALID_COMPARISON_REQUEST')
    const db = await this.open(value.analysisId)
    try {
      const group = db.prepare('SELECT kind,original_id FROM groups WHERE id=?').get(value.groupId) as Row | undefined
      if (!group) throw Error('GROUP_UNAVAILABLE')
      const query = db.prepare('SELECT f.*,EXISTS(SELECT 1 FROM groups WHERE original_id=f.id) AS protected FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? AND f.id=?')
      const ids = value.fileIds.length > 1 && group.original_id
        ? [group.original_id, ...value.fileIds.filter(id => id !== group.original_id)] : value.fileIds
      const files = ids.map(id => {
        const file = query.get(value.groupId, id) as Row | undefined
        if (!file) throw Error('FILE_UNAVAILABLE')
        return { id, name: path.basename(file.path), path: file.path, size: file.size, decision: file.decision, protected: !!file.protected }
      })
      return { analysisId: value.analysisId, groupId: value.groupId, kind: group.kind, originalId: group.original_id, files }
    } finally { db.close() }
  }
  async comparisonFile(value: unknown): Promise<ComparisonSnapshot> {
    if (this.locked) throw Error('CATALOG_BUSY')
    if (!isComparisonFileRequest(value)) throw Error('INVALID_COMPARISON_REQUEST')
    const db = await this.open(value.analysisId)
    try {
      const file = db.prepare('SELECT f.*,EXISTS(SELECT 1 FROM groups WHERE original_id=f.id) AS protected FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? AND f.id=?').get(value.groupId, value.fileId) as Row | undefined
      if (!file || file.decision === 'trashed') throw Error('FILE_UNAVAILABLE')
      const display = { id: file.id, name: path.basename(file.path), path: file.path, size: file.size, decision: file.decision, protected: !!file.protected }
      if (!this.executable) throw Error('FILE_HELPER_UNAVAILABLE')
      const directory = path.join(this.directory, 'preview-cache', value.sessionId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const existing = await readdir(directory)
      const used = (await Promise.all(existing.map(name => stat(path.join(directory, name))))).reduce((n, info) => n + info.size, 0)
      if (used + file.size > 2 * 1024 ** 3) return { ...display, status: 'limit' }
      const snapshot = path.join(directory, randomUUID() + '.bin')
      const result = await this.inspector(this.executable, { ...this.nativeRequest(db, file), action: 'snapshot', output: snapshot })
      if (result.status !== 'ready') return { ...display, status: result.status }
      if ((await stat(snapshot)).size !== file.size || !/^[a-f0-9]{64}$/.test(result.sha256 ?? '')) throw Error('INVALID_FILE_HELPER_RESULT')
      db.prepare('INSERT OR REPLACE INTO previews VALUES(?,?,?)').run(value.groupId, file.id, result.sha256!)
      let text: string | undefined
      if (path.extname(file.path).toLowerCase() === '.doc') {
        if (file.size > 32 * 1024 ** 2) return { ...display, status: 'limit' }
        try {
          const document = await new WordExtractor().extract(snapshot)
          text = [document.getHeaders(), document.getBody(), document.getFootnotes(), document.getEndnotes()].filter(Boolean).join('\n\n')
        } catch { return { ...display, status: 'invalid' } }
      }
      return { ...display, status: 'ready', snapshot, sha256: result.sha256, text }
    } finally { db.close() }
  }
  async clearComparison(sessionId?: unknown) {
    const root = path.join(this.directory, 'preview-cache')
    if (sessionId !== undefined && !idValid(sessionId)) throw Error('INVALID_COMPARISON_REQUEST')
    const sessions = sessionId ? [String(sessionId)] : await readdir(root).catch(() => [] as string[])
    for (const id of sessions) {
      if (!idValid(id)) continue
      const directory = path.join(root, id)
      if (!(await lstat(directory).catch(() => null))?.isDirectory()) continue
      for (const name of await readdir(directory)) if (/^[0-9a-f-]{36}\.bin$/.test(name)) await unlink(path.join(directory, name)).catch(() => {})
      await rmdir(directory).catch(() => {})
    }
  }
  async prepareTrash(value: unknown): Promise<TrashPlan> {
    if (!isTrashRequest(value)) throw Error('INVALID_TRASH_REQUEST')
    if (this.locked) throw Error('CATALOG_BUSY')
    const lease = { token: randomUUID(), analysisId: value.analysisId, groupId: value.groupId,
      entries: new Map<number, LeaseEntry>() }
    this.lease = lease
    let db: DatabaseSync | undefined
    try {
      db = await this.open(value.analysisId)
      const group = db.prepare('SELECT * FROM groups WHERE id=?').get(value.groupId) as Row | undefined
      if (!group?.original_id) throw Error('ORIGINAL_REQUIRED')
      const original = db.prepare('SELECT * FROM files WHERE id=?').get(group.original_id) as Row
      if (original.decision === 'trashed') throw Error('FILE_UNAVAILABLE')
      for (const fileId of value.fileIds) {
        const file = db.prepare('SELECT f.* FROM members m JOIN files f ON f.id=m.file_id WHERE m.group_id=? AND f.id=?').get(value.groupId, fileId) as Row | undefined
        if (!file || file.decision !== 'delete') throw Error('FILE_NOT_MARKED')
        if (file.identity === original.identity || db.prepare('SELECT 1 FROM groups WHERE original_id=?').get(file.id)) throw Error('ORIGINAL_PROTECTED')
        if ((db.prepare('SELECT state FROM trash_attempts WHERE file_id=?').get(file.id) as Row | undefined)?.state === 'pending') throw Error('TRASH_RESULT_UNCERTAIN')
        if (group.kind !== 'exact' && (!db.prepare('SELECT 1 FROM previews WHERE group_id=? AND file_id=?').get(group.id, file.id)
          || !db.prepare('SELECT 1 FROM previews WHERE group_id=? AND file_id=?').get(group.id, original.id))) throw Error('MANUAL_REVIEW_REQUIRED')
        lease.entries.set(file.id, { file, original, kind: group.kind })
      }
      return { token: lease.token, entries: [...lease.entries.values()].map(e => ({ fileId: e.file.id, path: e.file.path, originalPath: e.original.path, kind: e.kind })) }
    } catch (error) { this.lease = null; throw error } finally { db?.close() }
  }
  private leased(value: unknown, record = false) {
    if (!object(value) || !exactKeys(value, record ? ['token', 'fileId', 'success'] : ['token', 'fileId'])
      || value.token !== this.lease?.token || typeof value.fileId !== 'number' || record && typeof value.success !== 'boolean') throw Error('INVALID_TRASH_LEASE')
    const entry = this.lease!.entries.get(value.fileId)
    if (!entry) throw Error('INVALID_TRASH_LEASE')
    return { lease: this.lease!, entry, success: value.success as boolean }
  }
  async verifyTrash(value: unknown) {
    const { lease, entry } = this.leased(value)
    const db = await this.open(lease.analysisId)
    try {
      if (!this.executable) throw Error('FILE_HELPER_UNAVAILABLE')
      if ((db.prepare('SELECT decision FROM files WHERE id=?').get(entry.file.id) as Row)?.decision !== 'delete'
        || db.prepare('SELECT 1 FROM groups WHERE original_id=?').get(entry.file.id)) throw Error('ORIGINAL_PROTECTED')
      const guard = await fileGuard(entry.file.path), originalGuard = await fileGuard(entry.original.path)
      const result = await this.inspector(this.executable, { action: 'pair', exact: entry.kind === 'exact',
        left: this.nativeRequest(db, entry.original), right: this.nativeRequest(db, entry.file) })
      if (result.status !== 'ready' || !result.sha256 || !result.otherSha256
        || entry.original.hash && result.sha256 !== entry.original.hash || entry.file.hash && result.otherSha256 !== entry.file.hash
        || entry.kind === 'exact' && (!result.equal || result.sha256 !== result.otherSha256)) throw Error('FILE_CHANGED')
      if (entry.kind !== 'exact') {
        const proof = (id: number) => (db.prepare('SELECT sha256 FROM previews WHERE group_id=? AND file_id=?').get(lease.groupId, id) as Row | undefined)?.sha256
        if (proof(entry.original.id) !== result.sha256 || proof(entry.file.id) !== result.otherSha256) throw Error('PREVIEW_STALE')
      }
      if (guard !== await fileGuard(entry.file.path) || originalGuard !== await fileGuard(entry.original.path)) throw Error('FILE_CHANGED')
      db.prepare("INSERT OR REPLACE INTO trash_attempts VALUES(?,'pending')").run(entry.file.id)
      entry.verified = { left: result.sha256, right: result.otherSha256 }
      return { path: entry.file.path, originalPath: entry.original.path, guard, originalGuard }
    } finally { db.close() }
  }
  async executeTrash(value: unknown) {
    const { lease, entry } = this.leased(value)
    if (!this.executable || !entry.verified) throw Error('TRASH_NOT_STARTED')
    const db = await this.open(lease.analysisId)
    try {
      if (!db.prepare("SELECT 1 FROM trash_attempts WHERE file_id=? AND state='pending'").get(entry.file.id)) throw Error('TRASH_NOT_STARTED')
      let result
      try {
        result = await this.inspector(this.executable, { action: 'trash', exact: entry.kind === 'exact',
          left: this.nativeRequest(db, entry.original), right: this.nativeRequest(db, entry.file),
          expected_left_sha256: entry.verified.left, expected_right_sha256: entry.verified.right })
      } catch { throw Error('TRASH_RESULT_UNCERTAIN') }
      if (result.status === 'refused') throw Error('TRASH_REFUSED')
      if (result.status !== 'trashed') throw Error('TRASH_RESULT_UNCERTAIN')
      return { trashed: true }
    } finally { db.close() }
  }
  async recordTrash(value: unknown) {
    const { lease, entry, success } = this.leased(value, true)
    const db = await this.open(lease.analysisId)
    try {
      if (success && !db.prepare("SELECT 1 FROM trash_attempts WHERE file_id=? AND state IN ('pending','completed')").get(entry.file.id)) throw Error('TRASH_NOT_STARTED')
      db.exec('BEGIN')
      if (success) db.prepare("UPDATE files SET decision='trashed' WHERE id=?").run(entry.file.id)
      db.prepare('INSERT OR REPLACE INTO trash_attempts VALUES(?,?)').run(entry.file.id, success ? 'completed' : 'failed')
      db.exec('COMMIT')
      return { recorded: true }
    } finally { db.close() }
  }
  releaseTrash(value: unknown) {
    if (!object(value) || !exactKeys(value, ['token']) || !this.lease || value.token !== this.lease.token) throw Error('INVALID_TRASH_LEASE')
    this.lease = null
    return { released: true }
  }
}
