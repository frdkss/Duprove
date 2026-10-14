const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isReport, serializeReport } = require('../.verification/tests/contracts/validate.js')
const { prepareReport, sendReport } = require('../.verification/tests/electron/services/report-service.js')
const { reportFromEvent } = require('../.verification/tests/electron/services/analyzer-service.js')
const cases = require('../contracts/fixtures/cases.json')
for (const fixture of cases) test(fixture.name, () => assert.equal(isReport(fixture.report), fixture.valid))
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
