// Explicit integration suite: uses the deployment test's disposable localhost CA.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { HttpsReportTransport, MAX_REPORT_BYTES } = require('../.verification/tests/electron/services/report-transport.js')
const payload = JSON.stringify(require('../contracts/fixtures/example.json'))
const directory = process.env.DUPROVE_TEST_TLS_DIR
assert.ok(directory, 'Run test:delivery:deployment or set DUPROVE_TEST_TLS_DIR to a test-only localhost certificate directory')
const ca = fs.readFileSync(path.join(directory, 'fullchain.pem'), 'utf8')
const key = fs.readFileSync(path.join(directory, 'privkey.pem'), 'utf8')
async function fixture(t, handler) {
  const server = https.createServer({ cert: ca, key }, handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `https://127.0.0.1:${server.address().port}/v1/reports`
  return { url, transport: new HttpsReportTransport({ url, ca, timeoutMs: 1000 }) }
}
function reply(response, id, extra = {}) {
  response.writeHead(201, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ accepted: true, receipt_id: id, ...extra }))
}
const options = () => ({ signal: new AbortController().signal, reportId: randomUUID() })

test('actual HTTPS request has only the public JSON and permitted headers', async t => {
  let captured
  const f = await fixture(t, (request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      captured = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() }
      reply(response, request.headers['idempotency-key'])
    })
  })
  const authorization = options()
  await f.transport.send(payload, authorization)
  assert.equal(captured.method, 'POST'); assert.equal(captured.url, '/v1/reports'); assert.equal(captured.body, payload)
  assert.deepEqual(Object.keys(captured.headers).sort(), ['connection', 'content-length', 'content-type', 'host', 'idempotency-key'])
  assert.equal(captured.headers['idempotency-key'], authorization.reportId)
  assert.equal(captured.headers['content-length'], String(Buffer.byteLength(payload)))
})

test('untrusted certificate is rejected before an HTTP request', async t => {
  let calls = 0
  const f = await fixture(t, (_request, response) => { calls++; reply(response, '') })
  await assert.rejects(new HttpsReportTransport({ url: f.url, timeoutMs: 1000 }).send(payload, options()), error => error.code === 'TLS_FAILED')
  assert.equal(calls, 0)
})

test('redirects are not followed and cannot redirect report data elsewhere', async t => {
  let targetCalls = 0
  const target = await fixture(t, (_request, response) => { targetCalls++; response.end() })
  const source = await fixture(t, (_request, response) => { response.writeHead(307, { Location: target.url }); response.end() })
  await assert.rejects(source.transport.send(payload, options()), error => error.code === 'REPORT_REJECTED' && !error.retryable)
  assert.equal(targetCalls, 0)
})

test('success requires matching receipt, accepted=true and bounded JSON, not merely status 201', async t => {
  for (const body of ['{', '{}', JSON.stringify({ accepted: false, receipt_id: randomUUID() }), ' '.repeat(5000)]) {
    const f = await fixture(t, (_request, response) => { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(body) })
    await assert.rejects(f.transport.send(payload, options()))
  }
  const f = await fixture(t, (request, response) => reply(response, request.headers['idempotency-key'], { private: 'PRIVATE_PATH' }))
  await assert.rejects(f.transport.send(payload, options()), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('PRIVATE'))
})

test('absolute timeout stops a trickling response and consent abort closes the socket', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(201, { 'Content-Type': 'application/json' })
    const ticker = setInterval(() => response.write(' '), 10)
    response.on('close', () => clearInterval(ticker))
  })
  const started = Date.now()
  await assert.rejects(new HttpsReportTransport({ url: f.url, ca, timeoutMs: 150 }).send(payload, options()))
  assert.ok(Date.now() - started < 1500)
  const controller = new AbortController()
  const sent = f.transport.send(payload, { signal: controller.signal, reportId: randomUUID() })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(sent)
  let calls = 0
  const denied = await fixture(t, (_request, response) => { calls++; response.end() })
  await assert.rejects(denied.transport.send(payload, { signal: controller.signal, reportId: randomUUID() }))
  assert.equal(calls, 0)
})

test('rate limits, permanent errors and oversize requests are distinguished', async t => {
  for (const [status, retryable] of [[429, true], [503, true], [422, false], [409, false], [413, false]]) {
    const f = await fixture(t, (_request, response) => { response.writeHead(status, { 'Retry-After': '120' }); response.end('{}') })
    await assert.rejects(f.transport.send(payload, options()), error => error.retryable === retryable && error.retryAfterMs === 120_000)
  }
  const f = await fixture(t, () => assert.fail('Oversized request sent'))
  await assert.rejects(f.transport.send(' '.repeat(MAX_REPORT_BYTES + 1), options()), error => error.code === 'REPORT_TOO_LARGE')
})
