const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { prepareReport, savePreparedReport, loadPreparedReport, sendReport } = require('../.verification/tests/electron/services/report-service.js')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const cases = require('../contracts/fixtures/cases.json')

test('schema and arithmetic validation precede saving and transport', async t => {
  const workspace = path.resolve(__dirname, '../.verification')
  await fs.mkdir(workspace, { recursive: true })
  const directory = await fs.mkdtemp(path.join(workspace, 'report-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const consent = new ConsentService(path.join(directory, 'consent.json'))
  const prepared = prepareReport(cases[0].report, consent)
  const file = path.join(directory, 'report.json')
  savePreparedReport(file, prepared)
  const original = await fs.readFile(file, 'utf8')
  for (const fixture of cases.filter(c => !c.valid)) {
    const invalid = { ...prepared, report: fixture.report }
    assert.throws(() => savePreparedReport(file, invalid), /INVALID_REPORT/, fixture.name)
    assert.equal(await fs.readFile(file, 'utf8'), original, fixture.name)
    await assert.rejects(sendReport(invalid, consent, { send: async () => assert.fail('Invalid report sent') }), /INVALID_REPORT/)
  }
  const sent = []
  assert.equal(await sendReport(loadPreparedReport(file), consent, { send: async json => sent.push(JSON.parse(json)) }), true)
  assert.deepEqual(sent, [prepared.report])
  assert.deepEqual(Object.keys(sent[0]).sort(), ['complete', 'duplicates', 'schema_version', 'statistics'])
  assert.equal(JSON.stringify(sent).includes(prepared.consentGrantId), false)
  assert.deepEqual((await fs.readdir(directory)).sort(), ['consent.json', 'report.json'])
})

test('report I/O errors expose fixed codes without private paths', async t => {
  const workspace = path.resolve(__dirname, '../.verification')
  await fs.mkdir(workspace, { recursive: true })
  const directory = await fs.mkdtemp(path.join(workspace, 'report-errors-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const consent = new ConsentService(path.join(directory, 'consent.json'))
  const file = path.join(directory, 'PRIVATE_BLOCKED')
  await fs.writeFile(file, 'PRIVATE_CONTENT')
  assert.throws(() => savePreparedReport(path.join(file, 'PRIVATE_CHILD.json'), prepareReport(cases[0].report, consent)),
    error => error.message === 'REPORT_SAVE_FAILED')
  assert.throws(() => loadPreparedReport(file), error => error.message === 'REPORT_READ_FAILED')
  assert.throws(() => loadPreparedReport(path.join(directory, 'PRIVATE_MISSING')), error => error.message === 'REPORT_READ_FAILED')
})
