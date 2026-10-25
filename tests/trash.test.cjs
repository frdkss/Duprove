const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { CatalogService } = require('../.verification/tests/electron/services/catalog-service.js')
const { TrashService } = require('../.verification/tests/electron/services/trash-service.js')
const { trashConfirmationOptions } = require('../.verification/tests/electron/services/trash-confirmation.js')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '../.verification/trash-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const files = [1,2,3].map(n => path.join(directory, 'files', n + '.txt'))
  await fs.mkdir(path.dirname(files[0]))
  for (const file of files) await fs.writeFile(file, 'abc')
  const source = path.join(directory, 'source.sqlite'), db = new DatabaseSync(source)
  db.exec(`CREATE TABLE files(path TEXT,identity TEXT,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER,hash TEXT,gid INTEGER);
    CREATE TABLE content_files(path TEXT,status TEXT); CREATE TABLE content_matches(left_path TEXT,right_path TEXT,kind TEXT);`)
  for (let n = 0; n < files.length; n++) {
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)').run(files[n], 'identity:' + n, 0, 3, 1, 2, 'a'.repeat(64), 1)
    db.prepare("INSERT INTO content_files VALUES(?,'ready')").run(files[n])
  }
  db.prepare("INSERT INTO content_matches VALUES(?,?,'text')").run(files[1], files[2]); db.close()
  const inspect = async (_exe, request) => {
    const entries = request.action === 'pair' ? [request.left, request.right] : [request]
    for (const e of entries) if (await fs.readFile(e.path, 'utf8') !== 'abc') return { status: 'unavailable' }
    return request.action === 'pair' ? { status: 'ready', sha256: 'a'.repeat(64), otherSha256: 'a'.repeat(64), equal: true }
      : { status: 'ready', kind: 'text', text: 'abc', sha256: 'a'.repeat(64) }
  }
  const catalog = new CatalogService(directory, 'simulated-native-inspector', inspect)
  const analysisId = randomUUID()
  await catalog.capture(source, analysisId, [directory], true)
  const original = { action: 'original', analysisId, groupId: 'e:1', fileId: 1 }
  await catalog.request(original)
  for (const fileId of [2,3]) await catalog.request({ action: 'decision', analysisId, groupId: 'e:1', fileId, decision: 'delete', reviewed: false })
  const rpc = (method, value) => ({ trashPrepare: () => catalog.prepareTrash(value), trashVerify: () => catalog.verifyTrash(value), trashRecord: () => catalog.recordTrash(value), trashRelease: () => catalog.releaseTrash(value) })[method]()
  return { directory, files, catalog, analysisId, original, rpc, request: { analysisId, groupId: 'e:1', fileIds: [2,3] }, inspect }
}

test('trash accepts IDs only; cancellation changes no files and releases its lock', async t => {
  const f = await fixture(t)
  let calls = 0
  const service = new TrashService(f.rpc, async plan => { assert.equal(plan.entries[0].originalPath, f.files[0]); return false }, async () => { calls++ }, () => false)
  for (const v of [{ ...f.request, path: f.files[0] }, { ...f.request, fileIds: [] }, { ...f.request, fileIds: [2,2] }, { ...f.request, fileIds: [2.5] }]) await assert.rejects(service.run(v), /INVALID_TRASH_REQUEST/)
  const result = await service.run(f.request)
  assert.equal(result.cancelled, true); assert.equal(calls, 0); assert.equal(f.catalog.locked, false)
  assert.equal(await fs.readFile(f.files[1], 'utf8'), 'abc')
  await assert.rejects(service.run({ ...f.request, fileIds: [1] }), /FILE_NOT_MARKED/)
  await assert.rejects(service.run({ ...f.request, analysisId: randomUUID() }), /CATALOG_UNAVAILABLE/)
})

test('confirmation locks decisions, analysis/update entry and concurrent trash operations', async t => {
  const f = await fixture(t)
  let release
  const confirmation = new Promise(resolve => { release = resolve })
  const service = new TrashService(f.rpc, () => confirmation, async () => {}, () => false)
  const pending = service.run(f.request)
  while (!f.catalog.locked) await new Promise(r => setTimeout(r, 5))
  await assert.rejects(f.catalog.request(f.original), /CATALOG_BUSY/)
  await assert.rejects(service.run(f.request), /CATALOG_BUSY/)
  await assert.rejects(f.catalog.capture(path.join(f.directory, 'source.sqlite'), randomUUID(), [f.directory], true), /CATALOG_BUSY/)
  release(false); await pending
  assert.equal(service.busy, false)
  const blocked = new TrashService(f.rpc, async () => true, async () => {}, () => true)
  await assert.rejects(blocked.run(f.request), /CATALOG_BUSY/)
})

test('partial OS failures stay per-file, preserve original, update overlaps and cannot reprocess successful files', async t => {
  const f = await fixture(t)
  const calls = []
  const service = new TrashService(f.rpc, async () => true, async file => {
    calls.push(file)
    if (file === f.files[2]) throw Error('simulated unavailable recycle bin')
    await fs.rename(file, file + '.test-trash')
  }, () => false)
  const result = await service.run(f.request)
  assert.deepEqual(result.results.map(r => r.status), ['trashed','error'])
  assert.equal(await fs.readFile(f.files[0], 'utf8'), 'abc')
  assert.equal(await fs.readFile(f.files[2], 'utf8'), 'abc')
  const members = await f.catalog.request({ action: 'members', analysisId: f.analysisId, groupId: 't:1', offset: 0 })
  assert.equal(members.items[0].decision, 'trashed'); assert.equal(members.items[1].lastOperation, 'failed')
  await assert.rejects(service.run({ ...f.request, fileIds: [2] }), /FILE_NOT_MARKED/)
  assert.equal(calls.filter(p => p === f.files[1]).length, 1)
})

test('changed files after confirmation or final verification never reach the OS adapter', async t => {
  const f = await fixture(t)
  let calls = 0
  const service = new TrashService(f.rpc, async () => { await fs.writeFile(f.files[0], 'bad'); return true }, async () => { calls++ }, () => false)
  const result = await service.run(f.request)
  assert.ok(result.results.every(r => r.status === 'error')); assert.equal(calls, 0)
  await fs.writeFile(f.files[0], 'abc')
  const rpc = async (method, value) => {
    const result = await f.rpc(method, value)
    if (method === 'trashVerify') await fs.writeFile(f.files[1], 'bad')
    return result
  }
  const racing = new TrashService(rpc, async () => true, async () => { calls++ }, () => false)
  assert.equal((await racing.run({ ...f.request, fileIds: [2] })).results[0].status, 'error')
  assert.equal(calls, 0)
})

test('an interrupted OS attempt remains uncertain after restart and cannot be blindly repeated', async t => {
  const f = await fixture(t)
  const plan = await f.catalog.prepareTrash({ ...f.request, fileIds: [2] })
  await f.catalog.verifyTrash({ token: plan.token, fileId: 2 })
  f.catalog.releaseTrash({ token: plan.token })
  const restored = new CatalogService(f.directory, 'simulated-native-inspector', f.inspect)
  await assert.rejects(restored.prepareTrash({ ...f.request, fileIds: [2] }), /TRASH_RESULT_UNCERTAIN/)
  assert.equal(await fs.readFile(f.files[1], 'utf8'), 'abc')
})

test('a failed local acknowledgement retries only the acknowledgement, never the OS operation', async t => {
  const f = await fixture(t)
  let acknowledgements = 0, osCalls = 0
  const rpc = (method, value) => {
    if (method === 'trashRecord' && value.success && ++acknowledgements === 1) throw Error('simulated durable write failure')
    return f.rpc(method, value)
  }
  const service = new TrashService(rpc, async () => true, async file => { osCalls++; await fs.rename(file, file + '.test-trash') }, () => false)
  assert.equal((await service.run({ ...f.request, fileIds: [2] })).results[0].status, 'trashed')
  assert.equal(osCalls, 1); assert.equal(acknowledgements, 2)
})

test('confirmation defaults to cancellation, shows both full paths and distinguishes warnings', () => {
  const plan = { token: randomUUID(), entries: [{ fileId: 2, path: 'candidate full path', originalPath: 'original full path', kind: 'warn_text' }] }
  const options = trashConfirmationOptions(plan)
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
  assert.equal(options.buttons[0], 'Отмена')
  assert.ok(options.detail.includes(plan.entries[0].path) && options.detail.includes(plan.entries[0].originalPath))
  assert.match(options.detail, /содержимое может различаться/)
  assert.throws(() => trashConfirmationOptions({ ...plan, entries: [{ ...plan.entries[0], path: 'x'.repeat(60001) }] }), /CONFIRMATION_TOO_LARGE/)
})

test('a replaced parent junction/symlink is rejected before calling the OS adapter', async t => {
  const f = await fixture(t)
  const parent = path.dirname(f.files[0]), movedParent = path.join(f.directory, 'moved-files')
  await fs.rename(parent, movedParent)
  await fs.symlink(movedParent, parent, 'junction')
  let calls = 0
  const service = new TrashService(f.rpc, async () => true, async () => { calls++ }, () => false)
  const result = await service.run(f.request)
  assert.ok(result.results.every(r => r.status === 'error')); assert.equal(calls, 0)
  assert.equal(await fs.readFile(path.join(movedParent, '1.txt'), 'utf8'), 'abc')
})

test('an unknown native result leaves a pending intent and never permits a blind retry', async t => {
  const f = await fixture(t)
  let calls = 0
  const service = new TrashService(f.rpc, async () => true, async () => { calls++; throw Error('TRASH_RESULT_UNCERTAIN') }, () => false)
  const result = await service.run({ ...f.request, fileIds: [2] })
  assert.equal(result.results[0].error, 'TRASH_RESULT_UNCERTAIN')
  await assert.rejects(service.run({ ...f.request, fileIds: [2] }), /TRASH_RESULT_UNCERTAIN/)
  assert.equal(calls, 1)
  assert.equal(await fs.readFile(f.files[1], 'utf8'), 'abc')
})

test('Windows execution requires an established lease and binds both current verified digests', async t => {
  const f = await fixture(t)
  let nativeRequest
  const native = async (exe, request) => {
    if (request.action === 'trash') { nativeRequest = request; return { status: 'trashed' } }
    return f.inspect(exe, request)
  }
  const catalog = new CatalogService(f.directory, 'simulated-native-inspector', native)
  const plan = await catalog.prepareTrash({ ...f.request, fileIds: [2] })
  const lease = { token: plan.token, fileId: 2 }
  await assert.rejects(catalog.executeTrash(lease), /TRASH_NOT_STARTED/)
  await catalog.verifyTrash(lease)
  assert.equal((await catalog.executeTrash(lease)).trashed, true)
  assert.equal(nativeRequest.right.path, f.files[1]); assert.equal(nativeRequest.left.path, f.files[0])
  assert.equal(nativeRequest.expected_left_sha256, 'a'.repeat(64)); assert.equal(nativeRequest.expected_right_sha256, 'a'.repeat(64))
  await catalog.recordTrash({ ...lease, success: true }); catalog.releaseTrash({ token: plan.token })
})
