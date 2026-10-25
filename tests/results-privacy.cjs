const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { randomUUID } = require('node:crypto')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const { HttpsReportTransport } = require('../.verification/tests/electron/services/report-transport.js')
const { prepareReport, sendReport } = require('../.verification/tests/electron/services/report-service.js')
const root = path.resolve(__dirname, '..')
const directory = process.env.DUPROVE_RESULTS_TLS_DIR
assert.ok(directory)
const payload = fs.readFileSync(path.join(root, '.verification/results-integration-public.json'), 'utf8')
const report = JSON.parse(payload)
const cert = fs.readFileSync(path.join(directory, 'cert.pem'))
const key = fs.readFileSync(path.join(directory, 'key.pem'))
let calls = 0, captured
const server = https.createServer({ cert, key }, (request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    calls++; captured = { body: Buffer.concat(chunks).toString(), headers: request.headers }
    response.writeHead(201, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ accepted: true, receipt_id: request.headers['idempotency-key'] }))
  })
})
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const consent = new ConsentService(path.join(directory, 'consent.json'))
    const prepared = prepareReport(report, consent)
    const transport = new HttpsReportTransport({ url: `https://127.0.0.1:${server.address().port}/v1/reports`, ca: cert.toString(), timeoutMs: 5000 })
    assert.equal(await sendReport(prepared, consent, transport, randomUUID()), true)
    assert.equal(captured.body, payload)
    assert.deepEqual(Object.keys(captured.headers).sort(), ['connection','content-length','content-type','host','idempotency-key'])
    for (const marker of ['private-original.txt','PRIVATE_CONTENT_MARKER','originalId','decision','preview','groupId','/disk-a/','\\disk-a\\']) assert.equal(captured.body.includes(marker), false, marker)
    for (const [field, value] of Object.entries({ paths: ['PRIVATE_PATH'], originalId: 42, decision: 'delete', preview: 'PRIVATE_CONTENT', groupId: 'e:1' })) {
      await assert.rejects(sendReport({ ...prepared, report: { ...report, [field]: value } }, consent, transport, randomUUID()), /INVALID_REPORT/)
      await assert.rejects(sendReport({ ...prepared, [field]: value }, consent, transport, randomUUID()), /INVALID_PREPARED_REPORT/)
    }
    assert.equal(calls, 1, 'rejected private fields never reach the network')
    const proof = { passed: true, source: 'actual native scan after catalog decisions and recycle-bin operation',
      transport: 'actual loopback HTTPS with disposable CA and certificate verification', calls,
      exactPublicBody: true, privateFieldInjectionsRejected: 10, allowedHeadersOnly: true }
    fs.writeFileSync(path.join(root, '.verification/results-privacy-report.json'), JSON.stringify(proof, null, 2))
    console.log('RESULTS_PRIVACY_OK ' + JSON.stringify(proof))
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.closeAllConnections(); server.close() })
