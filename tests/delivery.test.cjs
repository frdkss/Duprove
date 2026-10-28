const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DeliveryService, DELIVERY_WINDOW } = require('../.verification/tests/electron/services/delivery-service.js')
const { DeliveryError, readTransportSettings } = require('../.verification/tests/electron/services/report-transport.js')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const { prepareReport, savePreparedReport } = require('../.verification/tests/electron/services/report-service.js')
const report = require('../contracts/fixtures/example.json')
const change = enabled => ({ enabled, noticeVersion: 2 })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw Error('DELIVERY_TEST_TIMEOUT'); await delay(10) }
}
function fixture(t, transport, configured = true) {
  const workspace = path.resolve(__dirname, '../.verification')
  fs.mkdirSync(workspace, { recursive: true })
  const directory = fs.mkdtempSync(path.join(workspace, 'delivery-'))
  const consent = new ConsentService(path.join(directory, 'consent.json'))
  let clock = 1_000_000
  const services = []
  const make = () => { const service = new DeliveryService(directory, consent, configured ? transport : null, null, () => clock, 0); services.push(service); return service }
  t.after(async () => {
    for (const service of services) await service.stop()
    assert.equal(path.dirname(path.resolve(directory)), workspace)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const save = (name = randomUUID()) => {
    const file = path.join(directory, 'reports', `${name}.json`)
    const prepared = prepareReport(report, consent)
    savePreparedReport(file, prepared)
    return { file, prepared }
  }
  return { directory, consent, make, save, advance: ms => { clock += ms },
    records: () => fs.readdirSync(path.join(directory, 'delivery')).map(name => JSON.parse(fs.readFileSync(path.join(directory, 'delivery', name)))) }
}

test('delivery persists identity, sends only a public report and restores acknowledged success', async t => {
  const calls = []
  const f = fixture(t, { send: async (json, options) => calls.push({ json, id: options.reportId }) })
  const { file, prepared } = f.save()
  const original = fs.readFileSync(file, 'utf8')
  const queue = f.make(); await queue.refresh(); await until(() => queue.snapshot().sent === 1)
  assert.deepEqual(JSON.parse(calls[0].json), report)
  assert.equal(calls[0].json.includes(prepared.consentGrantId), false)
  assert.notEqual(calls[0].id, prepared.consentGrantId)
  assert.equal(calls[0].id, f.records()[0].id)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  await queue.stop()
  const restarted = f.make(); await restarted.refresh(); await delay(20)
  assert.equal(restarted.snapshot().sent, 1); assert.equal(calls.length, 1)
})

test('lost acknowledgement retries with the same durable ID after restart and observes backoff', async t => {
  const ids = []
  const f = fixture(t, { send: async (_json, options) => { ids.push(options.reportId); if (ids.length === 1) throw new DeliveryError('NETWORK_UNAVAILABLE', true) } })
  f.save(); const queue = f.make(); await queue.refresh()
  await until(() => ids.length === 1 && !queue.snapshot().sending)
  await queue.stop()
  const restarted = f.make(); await restarted.refresh(); await delay(30)
  assert.equal(ids.length, 1, 'Restart must not reset persisted backoff')
  f.advance(60_000); restarted.consentChanged()
  await until(() => restarted.snapshot().sent === 1)
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(f.records()[0].attempts, 2)
})

test('a checkpoint updated during sending is followed by the final revision with a fresh ID', async t => {
  const calls = []
  let release
  const f = fixture(t, { send: async (json, options) => {
    calls.push({ report: JSON.parse(json), id: options.reportId })
    if (calls.length === 1) await new Promise(resolve => { release = resolve })
  } })
  const { file, prepared } = f.save()
  prepared.report.complete = false; savePreparedReport(file, prepared)
  const queue = f.make(); await queue.refresh(); await until(() => calls.length === 1)
  prepared.report.complete = true; savePreparedReport(file, prepared)
  await queue.refresh()
  assert.equal(queue.snapshot().sending, true)
  release()
  await until(() => calls.length === 2 && queue.snapshot().sent === 1)
  assert.deepEqual(calls.map(c => c.report.complete), [false, true])
  assert.notEqual(calls[0].id, calls[1].id)
})

test('newer progress supersedes an unsent checkpoint without resetting retry backoff', async t => {
  const ids = []
  const f = fixture(t, { send: async (_json, options) => {
    ids.push(options.reportId)
    if (ids.length === 1) throw new DeliveryError('NETWORK_UNAVAILABLE', true)
  } })
  const { file, prepared } = f.save()
  prepared.report.complete = false; savePreparedReport(file, prepared)
  const queue = f.make(); await queue.refresh(); await until(() => ids.length === 1 && !queue.snapshot().sending)
  const nextAttempt = queue.snapshot().nextAttemptAt
  prepared.report.complete = true; savePreparedReport(file, prepared)
  await queue.refresh(); await delay(30)
  assert.equal(ids.length, 1)
  assert.equal(queue.snapshot().nextAttemptAt, nextAttempt)
  f.advance(60_000); queue.consentChanged(); await until(() => queue.snapshot().sent === 1)
  assert.notEqual(ids[0], ids[1], 'A changed payload cannot reuse a possibly accepted ID')
  assert.equal(Math.max(...f.records().map(r => r.attempts)), 2)
})

test('a restart preserves backoff when the report changed after the last queue scan', async t => {
  const ids = []
  const f = fixture(t, { send: async (_json, options) => {
    ids.push(options.reportId)
    if (ids.length === 1) throw new DeliveryError('NETWORK_UNAVAILABLE', true)
  } })
  const { file, prepared } = f.save()
  prepared.report.complete = false; savePreparedReport(file, prepared)
  const queue = f.make(); await queue.refresh(); await until(() => ids.length === 1 && !queue.snapshot().sending)
  const nextAttempt = queue.snapshot().nextAttemptAt
  await queue.stop()
  prepared.report.complete = true; savePreparedReport(file, prepared)
  const restored = f.make(); await restored.refresh(); await delay(30)
  assert.equal(ids.length, 1)
  assert.equal(restored.snapshot().nextAttemptAt, nextAttempt)
  f.advance(60_000); restored.consentChanged(); await until(() => restored.snapshot().sent === 1)
  assert.notEqual(ids[0], ids[1])
})

test('revocation aborts in-flight upload; regrant never retags pending or previously unconsented reports', async t => {
  let calls = 0, aborted = 0
  const f = fixture(t, { send: async (_json, { signal }) => {
    calls++
    if (calls > 1) return
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(Error('PRIVATE_NETWORK_ERROR')) }, { once: true }))
  } })
  f.consent.set(change(false)); const denied = f.save()
  f.consent.set(change(true)); const pending = f.save(); f.save()
  const originals = [denied, pending].map(item => fs.readFileSync(item.file, 'utf8'))
  const queue = f.make(); await queue.refresh(); await until(() => calls === 1)
  f.consent.set(change(false)); queue.consentChanged()
  await until(() => aborted === 1 && !queue.snapshot().sending)
  f.consent.set(change(true)); queue.consentChanged(); await queue.refresh(); await delay(30)
  assert.equal(calls, 1); assert.equal(queue.snapshot().excluded, 3)
  assert.deepEqual([denied, pending].map(item => fs.readFileSync(item.file, 'utf8')), originals)
  f.save(); await queue.refresh(); await until(() => queue.snapshot().sent === 1)
  assert.equal(calls, 2)
})

test('at most five attempts survive restarts and never become successful when offline', async t => {
  let calls = 0
  const f = fixture(t, { send: async () => { calls++; throw new DeliveryError('NETWORK_UNAVAILABLE', true) } })
  f.save(); let queue = f.make(); await queue.refresh()
  for (let attempt = 1; attempt <= 5; attempt++) {
    await until(() => calls === attempt && !queue.snapshot().sending)
    await queue.stop(); f.advance([60_000, 300_000, 1800_000, 21600_000, 0][attempt - 1])
    queue = f.make(); await queue.refresh()
  }
  await delay(30)
  assert.equal(calls, 5); assert.equal(queue.snapshot().failed, 1); assert.equal(queue.snapshot().sent, 0)
})

test('a retry expires after 24 hours without contacting the server again', async t => {
  let calls = 0
  const f = fixture(t, { send: async () => { calls++; throw new DeliveryError('NETWORK_UNAVAILABLE', true) } })
  f.save(); const queue = f.make(); await queue.refresh(); await until(() => calls === 1 && !queue.snapshot().sending)
  f.advance(DELIVERY_WINDOW); queue.consentChanged(); await until(() => queue.snapshot().failed === 1)
  assert.equal(calls, 1)
})

test('crash during sending preserves counted attempt and ID on restore', async t => {
  const ids = []
  const f = fixture(t, { send: async (_json, options) => {
    ids.push(options.reportId)
    if (ids.length === 1) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('ABORT')), { once: true }))
  } })
  f.save(); const queue = f.make(); await queue.refresh(); await until(() => ids.length === 1)
  const interrupted = f.records()[0]; assert.equal(interrupted.status, 'sending'); assert.equal(interrupted.attempts, 1)
  await queue.stop()
  const stateFile = path.join(f.directory, 'delivery', fs.readdirSync(path.join(f.directory, 'delivery'))[0])
  fs.writeFileSync(stateFile, JSON.stringify(interrupted)) // Exact durable state at abrupt process loss.
  f.advance(60_000)
  const restored = f.make(); await restored.refresh(); await until(() => restored.snapshot().sent === 1)
  assert.deepEqual(ids, [interrupted.id, interrupted.id]); assert.equal(f.records()[0].attempts, 2)
})

test('replacement of a local report gets a distinct delivery identity without modifying its grant', async t => {
  const ids = []
  const f = fixture(t, { send: async (_json, options) => ids.push(options.reportId) })
  const { file, prepared } = f.save()
  const queue = f.make(); await queue.refresh(); await until(() => queue.snapshot().sent === 1)
  prepared.report.complete = !prepared.report.complete
  savePreparedReport(file, prepared)
  await queue.refresh(); await until(() => ids.length === 2 && !queue.snapshot().sending)
  assert.notEqual(ids[0], ids[1]); assert.equal(JSON.parse(fs.readFileSync(file)).consentGrantId, prepared.consentGrantId)
})

test('revocation immediately before transport is checked again after durable attempt recording', async t => {
  const f = fixture(t, { send: async () => assert.fail('Revoked report sent') })
  f.save(); const queue = f.make()
  queue.on('snapshot', state => {
    if (state.sending) { f.consent.set(change(false)); queue.consentChanged() }
  })
  await queue.refresh(); await until(() => queue.snapshot().excluded === 1)
  assert.equal(queue.snapshot().sent, 0)
})

test('permanent server rejection is visible and never retried', async t => {
  let calls = 0
  const f = fixture(t, { send: async () => { calls++; throw new DeliveryError('REPORT_REJECTED', false) } })
  f.save(); const queue = f.make(); await queue.refresh(); await until(() => queue.snapshot().failed === 1)
  f.advance(DELIVERY_WINDOW); queue.consentChanged(); await delay(20)
  assert.equal(calls, 1); assert.equal(queue.snapshot().sent, 0)
})

test('Retry-After is respected and the local attempt counter is not reset', async t => {
  let calls = 0
  const f = fixture(t, { send: async () => { calls++; throw new DeliveryError('RATE_LIMITED', true, 300_000) } })
  f.save(); const queue = f.make(); await queue.refresh(); await until(() => calls === 1 && !queue.snapshot().sending)
  f.advance(60_000); queue.consentChanged(); await delay(20); assert.equal(calls, 1)
  f.advance(240_000); queue.consentChanged(); await until(() => calls === 2)
})

test('invalid/oversized reports and corrupt delivery state never reach transport', async t => {
  const f = fixture(t, { send: async () => assert.fail('Unexpected send') }, false)
  const valid = f.save()
  const malformed = f.save(); fs.writeFileSync(malformed.file, '{"PRIVATE_PATH":"secret"}')
  const oversized = f.save(); fs.writeFileSync(oversized.file, ' '.repeat(3 * 1024 * 1024))
  const queue = f.make(); await queue.refresh(); await queue.stop()
  const stateFile = path.join(f.directory, 'delivery', fs.readdirSync(path.join(f.directory, 'delivery'))[0])
  fs.writeFileSync(stateFile, '{')
  const restarted = new DeliveryService(f.directory, f.consent, { send: async () => assert.fail('Unexpected send') })
  t.after(() => restarted.stop()); await restarted.refresh(); await delay(20)
  assert.equal(restarted.snapshot().failed, 3)
  assert.ok(fs.existsSync(valid.file)); assert.equal(fs.readFileSync(stateFile, 'utf8'), '{')
})

test('failed durable attempt prevents network traffic', async t => {
  const f = fixture(t, { send: async () => assert.fail('Unexpected send') })
  f.save()
  const originalRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).includes(`${path.sep}delivery${path.sep}`)) throw Error('PRIVATE_PATH')
    return originalRename(from, to)
  })
  const queue = f.make(); await queue.refresh(); await delay(20)
  assert.equal(queue.snapshot().failed, 1); assert.equal(queue.snapshot().error, 'DELIVERY_SAVE_FAILED')
})

test('unconfigured client stays local and shutdown cancels transport without losing retry identity', async t => {
  let id, aborted = false
  const f = fixture(t, { send: async (_json, options) => {
    id = options.reportId
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(Error('ABORT')) }, { once: true }))
  } })
  f.save(); const local = new DeliveryService(f.directory, f.consent, null)
  await local.refresh(); await delay(20); assert.equal(local.snapshot().pending, 1); await local.stop()
  const queue = f.make(); await queue.refresh(); await until(() => !!id); await queue.stop()
  assert.equal(aborted, true); assert.equal(f.records()[0].id, id); assert.equal(f.records()[0].status, 'pending')
})

test('endpoint settings require HTTPS and only development loopback can trust an explicit test CA', t => {
  const f = fixture(t, null, false)
  assert.equal(readTransportSettings(f.directory, true, {}), null)
  fs.writeFileSync(path.join(f.directory, '.env'), 'DUPROVE_REPORT_URL=https://127.0.0.1:8443/v1/reports\n')
  assert.equal(readTransportSettings(f.directory, false, {}).url, 'https://127.0.0.1:8443/v1/reports')
  assert.equal(readTransportSettings(f.directory, true, {}), null, 'Packaged build ignores .env')
  for (const url of ['http://127.0.0.1/v1/reports', 'https://user:password@example.test/v1/reports', 'https://example.test/v1/reports?q=x', 'https://example.test/other']) {
    assert.throws(() => readTransportSettings(f.directory, false, { DUPROVE_REPORT_URL: url }), /INVALID_ENDPOINT/)
  }
  assert.throws(() => readTransportSettings(f.directory, false, { DUPROVE_REPORT_URL: 'https://example.test/v1/reports', DUPROVE_CA_FILE: 'test.pem' }), /INVALID_ENDPOINT/)
})
