// Actual native scan -> catalog -> previews -> pair verification -> OS recycle bin.
// Only the user's confirmation response is injected, allowing deterministic cancel/accept tests.
const { app, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const unavailableTrash = process.env.DUPROVE_TEST_UNAVAILABLE_TRASH === '1'
const directory = path.join(process.env.DUPROVE_RESULTS_FIXTURES || path.join(root, '.verification'), 'results-integration-' + randomUUID())
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
const timeout = setTimeout(() => { console.error('RESULTS_INTEGRATION_TIMEOUT'); app.exit(1) }, 120000)

async function nativeScan(binary, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--job', input], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', data => { output += data; if (output.length > 8e6) { child.kill(); reject(Error('OUTPUT_LIMIT')) } })
    child.stderr.on('data', data => { error += data.slice(0, 200) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) reject(Error('SCAN_FAILED: ' + code + ' ' + error))
      else resolve(output.trim().split('\n').map(line => JSON.parse(line)).find(v => v.type === 'result'))
    })
    child.stdin.end()
  })
}

app.whenReady().then(async () => {
  const { CatalogService } = require('../.verification/tests/electron/services/catalog-service.js')
  const { TrashService } = require('../.verification/tests/electron/services/trash-service.js')
  const { isReport } = require('../.verification/tests/contracts/validate.js')
  const binary = process.env.DUPROVE_ANALYZER || path.join(root, 'build/native/bin', process.platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
  const roots = [path.join(directory, 'disk-a'), path.join(directory, 'disk-b')]
  const privateDirectory = path.join(directory, 'app'), database = path.join(privateDirectory, 'work/index.sqlite')
  for (const folder of roots) await fs.mkdir(folder, { recursive: true })
  const original = path.join(roots[0], 'private-original.txt'), duplicate = path.join(roots[1], 'private-copy.txt')
  const exactBytes = 'PRIVATE_CONTENT_MARKER\n<script>globalThis.PREVIEW_EXECUTED=true</script>\n'
  for (const file of [original, duplicate]) await fs.writeFile(file, exactBytes)
  const warnLeft = path.join(roots[0], 'warning-a.txt'), warnRight = path.join(roots[1], 'warning-b.txt')
  await fs.writeFile(warnLeft, 'Warning pair has separate content.\n')
  await fs.writeFile(warnRight, 'Warning  pair\t has separate content.\n')
  const input = path.join(directory, 'input.json')
  await fs.writeFile(input, JSON.stringify({ roots, database, private_directory: privateDirectory, load: 2, content: true }))
  const scan = await nativeScan(binary, input)
  assert.ok(scan?.report.complete)
  assert.equal(isReport(scan.report), true)
  const reportBytes = JSON.stringify(scan.report)
  for (const marker of [directory, 'private-original', 'PRIVATE_CONTENT_MARKER', 'originalId', 'decision', 'preview']) assert.equal(reportBytes.includes(marker), false, marker)
  const catalog = new CatalogService(privateDirectory, binary), analysisId = randomUUID()
  await catalog.capture(database, analysisId, roots, scan.report.complete)
  async function groupWith(kind, file) {
    const groups = await catalog.request({ action: 'groups', analysisId, kind, offset: 0 })
    for (const group of groups.items) {
      const page = await catalog.request({ action: 'members', analysisId, groupId: group.id, offset: 0 })
      if (page.items.some(v => v.path === file)) return { group, members: page.items }
    }
    throw Error('EXPECTED_GROUP_MISSING: ' + kind)
  }
  const exact = await groupWith('exact', original)
  const originalId = exact.members.find(v => v.path === original).id, duplicateId = exact.members.find(v => v.path === duplicate).id
  await catalog.request({ action: 'original', analysisId, groupId: exact.group.id, fileId: originalId })
  const pair = await catalog.request({ action: 'compare', analysisId, groupId: exact.group.id, fileId: duplicateId })
  assert.equal(pair.original.text, exactBytes); assert.equal(pair.candidate.text, exactBytes)
  await catalog.request({ action: 'decision', analysisId, groupId: exact.group.id, fileId: duplicateId, decision: 'delete', reviewed: false })
  const rpc = (method, value) => ({ trashPrepare: () => catalog.prepareTrash(value), trashVerify: () => catalog.verifyTrash(value), trashRecord: () => catalog.recordTrash(value), trashRelease: () => catalog.releaseTrash(value) })[method]()
  const request = { analysisId, groupId: exact.group.id, fileIds: [duplicateId] }
  let accepted = false, osCalls = 0
  const service = new TrashService(rpc, async plan => {
    assert.equal(plan.entries[0].path, plan.entries[0].kind === 'exact' ? duplicate : warnRight)
    assert.equal(plan.entries[0].originalPath, plan.entries[0].kind === 'exact' ? original : warnLeft)
    return accepted
  }, async (file, lease) => {
    osCalls++
    if (process.platform === 'win32') await catalog.executeTrash(lease)
    else await shell.trashItem(file)
  }, () => false)
  assert.equal((await service.run(request)).cancelled, true)
  assert.equal(await fs.readFile(duplicate, 'utf8'), exactBytes)
  accepted = true
  const transferred = await service.run(request)
  if (unavailableTrash) {
    assert.equal(transferred.results[0].status, 'error')
    assert.equal(osCalls, 1, 'native checks passed and the real OS adapter was called')
    assert.equal(await fs.readFile(duplicate, 'utf8'), exactBytes)
    assert.equal(await fs.readFile(original, 'utf8'), exactBytes)
    const proof = { passed: true, platform: process.platform, administrator: process.getuid?.() === 0,
      nativeVerification: 'real', osAdapter: 'real shell.trashItem refused transfer', osCalls,
      candidatePreserved: true, originalPreserved: true, permanentDeleteFallback: false }
    await fs.writeFile(path.join(root, '.verification/results-trash-unavailable-linux.json'), JSON.stringify(proof, null, 2))
    clearTimeout(timeout); console.log('RESULTS_TRASH_UNAVAILABLE_OK ' + JSON.stringify(proof)); app.exit(0); return
  }
  assert.equal(transferred.results[0].status, 'trashed')
  assert.equal(osCalls, 1)
  await assert.rejects(fs.stat(duplicate), /ENOENT/)
  assert.equal(await fs.readFile(original, 'utf8'), exactBytes)
  await assert.rejects(service.run(request), /FILE_NOT_MARKED/)

  const warning = await groupWith('warn_text', warnLeft)
  const leftId = warning.members.find(v => v.path === warnLeft).id, rightId = warning.members.find(v => v.path === warnRight).id
  await catalog.request({ action: 'original', analysisId, groupId: warning.group.id, fileId: leftId })
  await catalog.request({ action: 'compare', analysisId, groupId: warning.group.id, fileId: rightId })
  await catalog.request({ action: 'decision', analysisId, groupId: warning.group.id, fileId: rightId, decision: 'delete', reviewed: true })
  await fs.writeFile(warnRight, 'Changed after the explicit preview.\n')
  const refused = await service.run({ analysisId, groupId: warning.group.id, fileIds: [rightId] })
  assert.equal(refused.results[0].status, 'error'); assert.equal(osCalls, 1)
  assert.equal(await fs.readFile(warnLeft, 'utf8'), 'Warning pair has separate content.\n')
  assert.equal(reportBytes, JSON.stringify(scan.report), 'local decisions never mutate the statistical report')
  const restored = new CatalogService(privateDirectory, binary)
  const page = await restored.request({ action: 'members', analysisId, groupId: exact.group.id, offset: 0 })
  assert.equal(page.items.find(v => v.id === duplicateId).decision, 'trashed')
  const digest = createHash('sha256').update(await fs.readFile(binary)).digest('hex')
  const proof = { passed: true, platform: process.platform, analyzerSha256: digest, confirmations: 'injected cancel/accept only',
    nativeScan: 'real', previews: 'real', pairVerification: 'real', trash: process.platform === 'win32' ? 'real non-elevating Windows adapter; one disposable file' : 'real shell.trashItem; one disposable file', originalPreserved: true,
    stalePreviewRefused: true, statisticalReportUnchanged: true }
  await fs.writeFile(path.join(root, `.verification/results-integration-${process.platform}.json`), JSON.stringify(proof, null, 2))
  await fs.writeFile(path.join(root, '.verification/results-integration-public.json'), reportBytes)
  clearTimeout(timeout); console.log('RESULTS_INTEGRATION_OK ' + JSON.stringify(proof)); app.exit(0)
}).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1) })
