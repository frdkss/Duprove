const { test } = require('node:test')
const assert = require('node:assert/strict')
const { reportFromEvent, contentFromEvent } = require('../.verification/tests/electron/services/analyzer-service.js')
const { serializeReport } = require('../.verification/tests/contracts/validate.js')
const report = require('../contracts/fixtures/cases.json')[0].report
const valid = () => ({ type: 'result', report, content: {
  enabled: true, policy_version: 1, complete: true,
  files: { ready: report.statistics.total.files - report.statistics.total.empty, empty: report.statistics.total.empty, unsupported: 0, invalid: 0, protected: 0, limit: 0, unavailable: 0, stopped: 0 },
  warning_pairs: { text: 1, image: 0 },
  warnings: [{ status: 'warn', kind: 'text', files: [
    { id: 1, disk: 0, extension: '.txt', category: 'custom' },
    { id: 2, disk: 0, extension: '.md', category: 'custom' }
  ] }]
} })

test('local content warnings stay separate from the statistical report', () => {
  const event = valid()
  assert.deepEqual(contentFromEvent(event), event.content)
  assert.equal(serializeReport(reportFromEvent(event)), JSON.stringify(report))
  assert.throws(() => serializeReport({ ...report, content: event.content }), /INVALID_REPORT/)
  assert.throws(() => serializeReport(event), /INVALID_REPORT/)
})
test('content adapter rejects private fields, invalid counts, pairs and unsupported versions', () => {
  const changes = [
    c => { c.policy_version = 2 }, c => { c.text = 'PRIVATE_CONTENT' },
    c => { c.warning_pairs.text = 2 }, c => { c.files.ready++ },
    c => { c.warnings[0].files[0].path = 'PRIVATE_PATH' },
    c => { c.warnings[0].files[0].id = c.warnings[0].files[1].id },
    c => { c.warnings[0].files[0].disk = 64 },
    c => { c.warnings[0].files[0].extension = '.png' },
    c => { c.warnings[0].files[0].category = 'PRIVATE_FOLDER' },
    c => { c.warnings[0].status = 'duplicate' },
    c => { c.warnings.push(structuredClone(c.warnings[0])); c.warning_pairs.text++ },
    c => { c.files.stopped++; c.files.ready-- },
    c => { c.enabled = false }
  ]
  for (const change of changes) {
    const event = valid(); change(event.content)
    assert.throws(() => contentFromEvent(event), /INVALID_CONTENT_RESULT/)
  }
})
test('disabled content and partial content have explicit states', () => {
  const event = valid()
  event.content = { enabled: false, policy_version: 1, complete: true, files: {}, warning_pairs: { text: 0, image: 0 }, warnings: [] }
  assert.equal(contentFromEvent(event).enabled, false)
  const partial = valid()
  partial.content.complete = false
  partial.content.files.ready--
  partial.content.files.unavailable++
  partial.report = { ...report, complete: false }
  assert.equal(contentFromEvent(partial).complete, false)
})
