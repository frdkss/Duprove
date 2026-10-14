const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const { prepareReport, sendReport, savePreparedReport, loadPreparedReport } = require('../.verification/tests/electron/services/report-service.js')
const { STATISTICS_NOTICE_VERSION } = require('../.verification/tests/contracts/consent.js')
const report = require('../contracts/fixtures/example.json')
const change = enabled => ({ enabled, noticeVersion: STATISTICS_NOTICE_VERSION })
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duprove-consent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'consent.json')
  return { file, directory, service: new ConsentService(file) }
}

test('a new profile enables statistics by default; the default and quiet refusal survive restart', async t => {
  const { file, service } = fixture(t)
  assert.deepEqual(service.snapshot(), { decision: 'default-enabled', noticeVersion: STATISTICS_NOTICE_VERSION, persistenceError: false })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).decision, 'default-enabled', 'The default is not recorded as explicit consent')
  assert.equal(new ConsentService(file).current().grantId, service.current().grantId)
  const sent = []
  assert.equal(await sendReport(prepareReport(report, service), service, { send: async json => sent.push(JSON.parse(json)) }), true)
  assert.deepEqual(sent, [report])
  assert.equal(service.set(change(false)).decision, 'declined')
  assert.equal(new ConsentService(file).snapshot().decision, 'declined')
  service.set(change(true))
  const grant = service.current().grantId
  assert.equal(new ConsentService(file).current().grantId, grant)
  service.set(change(true))
  assert.equal(service.current().grantId, grant, 'Idempotent grant does not orphan valid pending reports')
  assert.equal(Object.hasOwn(service.snapshot(), 'grantId'), false, 'Grant metadata is not exposed to UI')
  service.set(change(false))
  assert.equal(new ConsentService(file).current(), null)
})

test('malformed, foreign and unsupported consent never falls back to enabled', t => {
  const { file } = fixture(t)
  const valid = { version: 1, noticeVersion: STATISTICS_NOTICE_VERSION, decision: 'granted', grantId: randomUUID() }
  for (const contents of ['{', 'null', 'true', '[]', ...[
    { ...valid, version: 2 }, { ...valid, noticeVersion: 0 }, { ...valid, noticeVersion: STATISTICS_NOTICE_VERSION + 1 },
    { ...valid, decision: true }, { ...valid, grantId: null }, { ...valid, extra: true },
    { ...valid, decision: 'declined' }, { ...valid, noticeVersion: 1, decision: 'default-enabled' }, { enabled: true },
  ].map(JSON.stringify)]) {
    fs.writeFileSync(file, contents)
    assert.equal(new ConsentService(file).current(), null, contents)
  }
})

test('the new default preserves both explicit choices from notice v1', t => {
  const { file } = fixture(t)
  for (const decision of ['declined', 'granted']) {
    const record = { version: 1, noticeVersion: 1, decision, grantId: decision === 'granted' ? randomUUID() : null }
    fs.writeFileSync(file, JSON.stringify(record))
    const restored = new ConsentService(file)
    assert.equal(restored.snapshot().decision, decision)
    assert.equal(restored.current()?.grantId ?? null, record.grantId)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record, 'Reading must not overwrite an existing choice')
  }
})

test('IPC-shaped consent requests are validated without coercion or incidental grants', t => {
  const { service } = fixture(t)
  service.set(change(false))
  for (const request of [null, true, [], {}, { ...change(true), enabled: 'true' },
    { ...change(true), enabled: 1 }, { enabled: true }, { enabled: true, noticeVersion: 0 },
    { enabled: true, noticeVersion: 1 },
    { ...change(true), extra: true }]) {
    assert.throws(() => service.set(request), /INVALID_CONSENT_REQUEST/)
    assert.equal(service.current(), null)
  }
})

test('revocation keeps reports locally and permanently excludes old reports after regrant and restart', async t => {
  const { file, directory, service } = fixture(t)
  service.set(change(false))
  const withoutConsent = prepareReport(report, service)
  service.set(change(true))
  const pending = prepareReport(report, service)
  const localFile = path.join(directory, 'pending.json')
  savePreparedReport(localFile, pending)
  const localBytes = fs.readFileSync(localFile, 'utf8')
  const sent = []
  const transport = { send: async (json, { signal }) => { assert.equal(signal.aborted, false); sent.push(JSON.parse(json)) } }
  assert.equal(await sendReport(loadPreparedReport(localFile), new ConsentService(file), transport), true)
  service.set(change(false))
  assert.equal(await sendReport(pending, service, transport), false)
  service.set(change(true))
  const restarted = new ConsentService(file)
  assert.equal(await sendReport(withoutConsent, restarted, transport), false)
  assert.equal(await sendReport(loadPreparedReport(localFile), restarted, transport), false)
  assert.equal(fs.readFileSync(localFile, 'utf8'), localBytes, 'Revocation does not delete or rewrite local results')
  assert.equal(await sendReport(prepareReport(report, restarted), restarted, transport), true)
  assert.deepEqual(sent, [report, report], 'Only the public report reaches transport')
})

test('revocation during a batch stops subsequent reports and cancels the current transport', async t => {
  const { service } = fixture(t)
  service.set(change(true))
  const pending = [prepareReport(report, service), prepareReport(report, service)]
  let calls = 0
  const transport = { send: (_json, { signal }) => new Promise((_resolve, reject) => {
    calls++
    signal.addEventListener('abort', () => reject(Error('ABORTED')), { once: true })
    service.set(change(false))
  }) }
  for (const item of pending) assert.equal(await sendReport(item, service, transport), false)
  assert.equal(calls, 1)
})

test('offline retries preserve the original consent scope', async t => {
  const { service } = fixture(t)
  service.set(change(true))
  const pending = prepareReport(report, service)
  let calls = 0
  const transport = { send: async () => { calls++; throw Error('OFFLINE') } }
  await assert.rejects(sendReport(pending, service, transport), /OFFLINE/)
  service.set(change(false))
  service.set(change(true))
  assert.equal(await sendReport(pending, service, transport), false)
  assert.equal(calls, 1)
})

test('failed persistence cannot enable the default; failed revoke retains a denial instead of deleting the file', t => {
  const { file, directory, service } = fixture(t)
  service.set(change(false))
  const failure = t.mock.method(fs, 'renameSync', () => { throw Error('DISK_ERROR') })
  const fresh = new ConsentService(path.join(directory, 'new-profile.json'))
  assert.equal(fresh.current(), null)
  assert.equal(fresh.snapshot().persistenceError, true)
  assert.equal(service.set(change(true)).persistenceError, true)
  assert.equal(service.current(), null)
  failure.mock.restore()
  service.set(change(true))
  const signal = service.current().signal
  const revokeFailure = t.mock.method(fs, 'renameSync', () => { throw Error('DISK_ERROR') })
  assert.equal(service.set(change(false)).persistenceError, false, 'Fallback writes a persistent denial')
  assert.equal(service.current(), null)
  assert.equal(signal.aborted, true)
  assert.equal(new ConsentService(file).current(), null)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).decision, 'declined')
  revokeFailure.mock.restore()
  service.set(change(true))
  t.mock.method(fs, 'renameSync', () => { throw Error('DISK_ERROR') })
  const originalWrite = fs.writeFileSync
  const writeFailure = t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    if (target === file) throw Error('DISK_ERROR')
    return originalWrite(target, data, options)
  })
  assert.equal(service.set(change(false)).persistenceError, true, 'UI must disclose that the choice could not be persisted')
  assert.equal(service.current(), null)
  writeFailure.mock.restore()
})

test('prepared reports are validated and snapshotted; malformed or legacy storage cannot bypass consent', async t => {
  const { directory, service } = fixture(t)
  service.set(change(true))
  const original = structuredClone(report)
  const prepared = prepareReport(original, service)
  original.privatePath = 'PRIVATE_PATH'
  assert.deepEqual(prepared.report, report)
  const localFile = path.join(directory, 'report.json')
  for (const value of [report, {}, { ...prepared, consentGrantId: true }, { ...prepared, privatePath: 'PRIVATE_PATH' },
    { ...prepared, report: { ...report, privatePath: 'PRIVATE_PATH' } }]) {
    fs.writeFileSync(localFile, JSON.stringify(value))
    assert.throws(() => loadPreparedReport(localFile), /INVALID_(PREPARED_)?REPORT/)
    await assert.rejects(sendReport(value, service, { send: async () => assert.fail('Must not send') }), /INVALID_(PREPARED_)?REPORT/)
  }
  assert.throws(() => loadPreparedReport(path.join(directory, 'PRIVATE_FILENAME')), error => error.message === 'REPORT_READ_FAILED')
})
