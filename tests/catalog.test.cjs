const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { CatalogService, CATALOG_AGE } = require('../.verification/tests/electron/services/catalog-service.js')
const { isCatalogRequest } = require('../.verification/tests/contracts/catalog.js')

async function fixture(t, count = 1051) {
  const directory = await fs.mkdtemp(path.join(__dirname, '../.verification/catalog-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'work.sqlite')
  const db = new DatabaseSync(source)
  db.exec(`CREATE TABLE files(path TEXT,identity TEXT,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER,hash TEXT,gid INTEGER);
    CREATE TABLE content_files(path TEXT,status TEXT); CREATE TABLE content_matches(left_path TEXT,right_path TEXT,kind TEXT); BEGIN;`)
  const insert = db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)')
  for (let i = 1; i <= count; i++) insert.run(path.join(directory, `${i % 2 ? 'disk-a' : 'disk-b'}-${i}.txt`), `identity:${i}`, i % 2, 3, 134000000000000001n, 134000000000000002n, 'a'.repeat(64), 1)
  insert.run(path.join(directory, 'singleton.txt'), 'singleton', 0, 9, 1, 2, 'b'.repeat(64), 2)
  const names = [1, 2, 3].map(i => path.join(directory, `${i % 2 ? 'disk-a' : 'disk-b'}-${i}.txt`))
  for (const name of names) db.prepare('INSERT INTO content_files VALUES(?,?)').run(name, 'ready')
  for (let i = 0; i < 2; i++) db.prepare('INSERT INTO content_matches VALUES(?,?,?)').run(names[i], names[i + 1], 'text')
  db.exec('COMMIT'); db.close()
  const analysisId = randomUUID()
  const catalog = new CatalogService(directory)
  await catalog.capture(source, analysisId, [directory], true)
  return { directory, source, catalog, analysisId, names, count }
}

test('catalog retains precise metadata, large cross-root groups and separate warning pairs after work cleanup', async t => {
  const f = await fixture(t)
  await fs.unlink(f.source)
  const restored = new CatalogService(f.directory)
  const info = await restored.request({ action: 'info', analysisId: f.analysisId })
  assert.deepEqual(info.groups, { exact: 1, warn_text: 2, warn_image: 0 })
  assert.equal(info.files, f.count)
  const groups = await restored.request({ action: 'groups', analysisId: f.analysisId, kind: 'exact', offset: 0 })
  assert.equal(groups.items[0].count, f.count)
  assert.equal(groups.items[0].originalId, null)
  const members = await restored.request({ action: 'members', analysisId: f.analysisId, groupId: 'e:1', offset: 1025 })
  assert.equal(members.total, f.count); assert.equal(members.items.length, 25)
  assert.equal(members.items[0].id, 1026)
  assert.equal(members.items[0].availability, 'missing')
  await fs.writeFile(members.items[0].path, 'abc')
  assert.equal((await restored.request({ action: 'members', analysisId: f.analysisId, groupId: 'e:1', offset: 1025 })).items[0].availability, 'available')
  const db = await restored.open(f.analysisId)
  assert.equal(db.prepare('SELECT mtime FROM files LIMIT 1').get().mtime, '134000000000000001')
  db.close()
  const warn = await restored.request({ action: 'groups', analysisId: f.analysisId, kind: 'warn_text', offset: 0 })
  assert.ok(warn.items.every(g => g.count === 2 && g.kind === 'warn_text'))
})

test('catalog rejects injected paths, SQL, wrong analyses, missing and expired results', async t => {
  const f = await fixture(t, 4)
  for (const v of [null, { action: 'info', analysisId: f.analysisId, path: 'arbitrary' },
    { action: 'members', analysisId: f.analysisId, groupId: "e:1' OR 1=1", offset: 0 },
    { action: 'groups', analysisId: f.analysisId, kind: 'exact', offset: -1 },
    { action: 'groups', analysisId: f.analysisId, kind: 'exact', offset: 0.5 }]) {
    assert.equal(isCatalogRequest(v), false)
    await assert.rejects(f.catalog.request(v), /INVALID_CATALOG_REQUEST/)
  }
  await assert.rejects(f.catalog.request({ action: 'info', analysisId: randomUUID() }), /CATALOG_UNAVAILABLE/)
  await f.catalog.capture(f.source, randomUUID(), [f.directory], false)
  await assert.rejects(f.catalog.request({ action: 'info', analysisId: f.analysisId }), /CATALOG_UNAVAILABLE/)
  await f.catalog.capture(f.source, f.analysisId, [f.directory], false)
  const db = await f.catalog.open(f.analysisId)
  db.prepare('UPDATE meta SET created_at=?').run(Date.now() - CATALOG_AGE - 1); db.close()
  await assert.rejects(f.catalog.request({ action: 'info', analysisId: f.analysisId }), /CATALOG_EXPIRED/)
  await assert.rejects(fs.stat(f.catalog.file), /ENOENT/)
  await assert.rejects(f.catalog.request({ action: 'info', analysisId: f.analysisId }), /CATALOG_UNAVAILABLE/)
})

module.exports = { fixture }
