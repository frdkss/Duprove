const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isReport, serializeReport } = require('../.verification/tests/contracts/validate.js')
const { prepareReport, sendReport } = require('../.verification/tests/electron/services/report-service.js')
const { reportFromEvent } = require('../.verification/tests/electron/services/analyzer-service.js')
const cases = require('../contracts/fixtures/cases.json')
for (const fixture of cases) test(fixture.name, () => assert.equal(isReport(fixture.report), fixture.valid))

test('byte counters, volume totals and progress are checked without losing legacy compatibility', () => {
  const report = require('../contracts/fixtures/byte-example.json')
  assert.ok(isReport(report))
  for (const mutate of [
    r => r.duplicates[0].size_bytes++,
    r => r.statistics.total.file_bytes++,
    r => r.statistics.total.duplicate_bytes++,
    r => r.statistics.total.reclaimable_bytes++,
    r => delete r.statistics.disks[0].file_bytes,
    r => r.statistics.disks[0].used_bytes++,
    r => r.statistics.total.used_bytes = 9007199254740992,
    r => r.progress.disks[0].id = 1,
    r => r.progress.disks[0].work.current = 'PRIVATE_PATH',
    r => Object.assign(r.progress.disks[0].work, { done: 2, total: 1 }),
    r => r.progress.status = 'running',
  ]) {
    const invalid = structuredClone(report); mutate(invalid)
    assert.equal(isReport(invalid), false)
  }
})
test('reject non-JSON values and overflow', () => {
  for (const value of [undefined, null, [], NaN, Infinity]) assert.equal(isReport(value), false)
  const report = structuredClone(cases[0].report)
  report.statistics.total.files = Infinity
  assert.equal(isReport(report), false)
})
test('internal event data cannot enter report serialization', () => {
  const event = { type: 'result', report: cases[0].report, disks: [{path:'PRIVATE_PATH',hash:'PRIVATE_HASH'}] }
  assert.equal(serializeReport(reportFromEvent(event)).includes('PRIVATE_'), false)
  assert.throws(() => serializeReport(event), /INVALID_REPORT/)
})
test('transport checks current consent on every send', async () => {
  const authorization = { grantId: require('node:crypto').randomUUID(), signal: new AbortController().signal }
  let consent = authorization
  const sent = []
  const transport = { send: async json => sent.push(JSON.parse(json)) }
  const provider = { current: () => consent }
  const prepared = prepareReport(cases[0].report, provider)
  consent = null
  assert.equal(await sendReport(prepared, provider, transport), false)
  consent = authorization
  assert.equal(await sendReport(prepared, provider, transport), true)
  consent = null
  assert.equal(await sendReport(prepared, provider, transport), false)
  assert.deepEqual(sent, [cases[0].report])
})
test('invalid payload never reaches transport; transport failure is propagated', async () => {
  let called = false
  const provider = { current: () => ({ grantId: require('node:crypto').randomUUID(), signal: new AbortController().signal }) }
  assert.throws(() => prepareReport({}, provider), /INVALID_REPORT/)
  await assert.rejects(sendReport({}, provider, {send:async()=>{called=true}}), /INVALID_PREPARED_REPORT/)
  await assert.rejects(sendReport({version: 1, consentGrantId: null, report: {}}, provider, {send:async()=>{called=true}}), /INVALID_REPORT/)
  assert.equal(called, false)
  const grant = provider.current()
  const consent = {current:()=>grant}
  await assert.rejects(sendReport(prepareReport(cases[0].report, consent), consent, {send:async()=>{throw Error('OFFLINE')}}), /OFFLINE/)
})
