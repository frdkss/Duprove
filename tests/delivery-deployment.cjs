// Actual analyzer -> prepared report -> restart/retry -> HTTPS Docker receiver.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JobService } = require('../.verification/tests/electron/services/job-service.js')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const { DeliveryService } = require('../.verification/tests/electron/services/delivery-service.js')
const { DeliveryError, HttpsReportTransport } = require('../.verification/tests/electron/services/report-transport.js')
const { sendReport } = require('../.verification/tests/electron/services/report-service.js')
const { isReport } = require('../.verification/tests/contracts/validate.js')
const root = path.resolve(__dirname, '..')
async function until(predicate) {
  const deadline = Date.now() + 25_000
  while (!predicate()) { if (Date.now() > deadline) throw Error('DELIVERY_DEPLOYMENT_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
async function main() {
  const workspace = path.join(root, '.verification'); fs.mkdirSync(workspace, { recursive: true })
  const directory = fs.mkdtempSync(path.join(workspace, 'delivery-e2e-'))
  let jobs, queue, restarted
  try {
    const drive = path.join(directory, 'PRIVATE_DIRECTORY'); fs.mkdirSync(drive)
    for (const file of ['PRIVATE_FILENAME_A.txt', 'PRIVATE_FILENAME_B.txt']) fs.writeFileSync(path.join(drive, file), 'PRIVATE_FILE_CONTENT')
    const profile = path.join(directory, 'profile'), consentFile = path.join(directory, 'consent.json')
    const consent = new ConsentService(consentFile)
    const executable = process.env.DUPROVE_ANALYZER || path.join(root, 'build/native/bin', process.platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
    jobs = new JobService(executable, profile, consentFile, async () => [{ path: drive, name: 'PRIVATE_DRIVE', capacity: 1000000, available: 500000 }])
    await jobs.start({ version: 1, roots: [drive], content: false, mode: 'high' })
    await until(() => jobs.snapshot().status === 'completed' || jobs.snapshot().status === 'error')
    assert.equal(jobs.snapshot().status, 'completed', jobs.snapshot().error)
    const file = path.join(profile, 'reports', `${jobs.snapshot().id}.json`)
    const original = fs.readFileSync(file, 'utf8')
    const prepared = JSON.parse(original)
    const wire = new HttpsReportTransport({ url: process.env.DUPROVE_TEST_REPORT_URL,
      ca: fs.readFileSync(path.join(process.env.DUPROVE_TEST_TLS_DIR, 'fullchain.pem'), 'utf8') })
    const ids = []
    const transport = { send: async (json, options) => {
      assert.ok(isReport(JSON.parse(json))); assert.equal(json.includes('PRIVATE'), false)
      assert.equal(json.includes(prepared.consentGrantId), false)
      assert.equal(json.includes(drive), false)
      ids.push(options.reportId)
      await wire.send(json, options)
      if (ids.length === 1) throw new DeliveryError('NETWORK_UNAVAILABLE', true) // Response not durably acknowledged by the client.
    } }
    let clock = Date.now()
    queue = new DeliveryService(profile, consent, transport, null, () => clock, 0)
    await queue.refresh(); await until(() => ids.length === 1 && !queue.snapshot().sending)
    assert.equal(queue.snapshot().sent, 0); await queue.stop()
    clock += 60_000
    restarted = new DeliveryService(profile, consent, transport, null, () => clock, 0)
    await restarted.refresh(); await until(() => restarted.snapshot().sent === 1)
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(fs.readFileSync(file, 'utf8'), original)
    consent.set({ enabled: false, noticeVersion: 2 }); restarted.consentChanged()
    assert.equal(await sendReport(prepared, consent, { send: async () => assert.fail('Denied report sent') }, ids[0]), false)
    consent.set({ enabled: true, noticeVersion: 2 }); restarted.consentChanged()
    assert.equal(await sendReport(prepared, consent, { send: async () => assert.fail('Old report sent after regrant') }, ids[0]), false)
    assert.equal(jobs.snapshot().status, 'completed', 'Delivery does not change analysis outcome')
    console.log('DELIVERY_DEPLOYMENT_OK: synthetic analysis, private-field checks, lost acknowledgement, restart, same-ID retry and revocation passed')
  } finally {
    await queue?.stop(); await restarted?.stop(); await jobs?.shutdown()
    assert.equal(path.dirname(path.resolve(directory)), workspace)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
