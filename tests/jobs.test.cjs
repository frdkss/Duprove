const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { JobService, cleanupWorkFile, WORK_FILE_THRESHOLD } = require('../.verification/tests/electron/services/job-service.js')
const { isStartAnalysis, isDiskProgress, overallProgress, waitingDisk, analysisFinished, emptySnapshot } = require('../.verification/tests/contracts/analysis.js')
const { ConsentService } = require('../.verification/tests/electron/services/consent-service.js')
const root = path.resolve(__dirname, '..')
const binary = process.env.DUPROVE_ANALYZER || path.join(root, 'build/native/bin', process.platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
async function fixture(t, bytes = 1024 * 1024) {
  await fs.mkdir(path.join(root, '.verification'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, '.verification/jobs-'))
  const roots = [path.join(directory, 'a'), path.join(directory, 'b')]
  for (const disk of roots) { await fs.mkdir(disk); await fs.writeFile(path.join(disk, 'private.bin'), Buffer.alloc(bytes, 81)) }
  await fs.writeFile(path.join(roots[0], 'empty'), '')
  const drives = roots.map(p => ({ path: p, name: path.basename(p), capacity: 10e9, available: 5e9 }))
  const consentFile = path.join(directory, 'consent.json')
  const consent = new ConsentService(consentFile)
  const make = () => new JobService(binary, path.join(directory, 'app'), consentFile, async () => drives)
  const service = make()
  const services = [service]
  t.after(async () => { for (const s of services) await s.shutdown(); await fs.rm(directory, { recursive: true, force: true }) })
  return { service, services, directory, roots, consent, make, request: { version: 1, roots, mode: 'high', content: false } }
}
function until(service, predicate, timeout = 20000) {
  if (predicate(service.snapshot())) return Promise.resolve(service.snapshot())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { service.off('snapshot', receive); reject(new Error(`JOB_TIMEOUT:${JSON.stringify(service.snapshot())}`)) }, timeout)
    const receive = state => { if (predicate(state)) { clearTimeout(timer); service.off('snapshot', receive); resolve(state) } }
    service.on('snapshot', receive)
  })
}

test('analysis contract rejects unknown versions, paths, modes and malformed progress', () => {
  const valid = { version: 1, roots: ['x'], mode: 'low', content: false }
  assert.ok(isStartAnalysis(valid))
  for (const request of [{ ...valid, version: 2 }, { ...valid, mode: 2 }, { ...valid, roots: ['x', 'x'] }, { ...valid, database: 'private' }, { ...valid, content: 'yes' }]) assert.equal(isStartAnalysis(request), false)
  assert.ok(isDiskProgress(waitingDisk('x')))
  for (const progress of [{ ...waitingDisk('x'), percent: NaN }, { ...waitingDisk('x'), overall_percent: Infinity }, { ...waitingDisk('x'), overall_percent: -1 }, { ...waitingDisk('x'), files: 2 }, { ...waitingDisk('x'), hash: 'secret' }]) assert.equal(isDiskProgress(progress), false)
  const legacy = waitingDisk('x'); delete legacy.overall_percent
  assert.ok(isDiskProgress(legacy), 'Existing saved snapshots remain readable')
  const cached = { ...waitingDisk('x'), work: { operation: 'hashing', current: 'fixture', done: 10, total: 10, unit: 'bytes', read_bytes: 0, files_done: 2, files_total: 2, cached_files: 2 } }
  assert.ok(isDiskProgress(cached))
  assert.equal(isDiskProgress({ ...cached, work: { ...cached.work, cached_files: 3 } }), false)
  const issue = { code: 'metadata_unavailable', operation: 'discovering', count: 1, examples: ['synthetic/file'] }
  assert.ok(isDiskProgress({ ...waitingDisk('x'), errors: 1, issues: [issue] }))
  for (const invalid of [{ ...issue, count: 2 }, { ...issue, code: 'unknown' }, { ...issue, examples: ['x'.repeat(1025)] }, { ...issue, extra: true }]) {
    assert.equal(isDiskProgress({ ...waitingDisk('x'), errors: 1, issues: [invalid] }), false)
  }
})

test('overall progress keeps completed stages across waits and never resets at phase boundaries', () => {
  for (const content of [false, true]) {
    let previous = waitingDisk('x')
    const sequence = [['discovering', null], ['waiting', null], ['hashing', 40], ['hashing', 100], ['waiting', null], ['comparing', 0], ['comparing', 100],
      ...(content ? [['content', 0], ['content', 100], ['content_comparing', null]] : []), ['validating', null], ['completed', 100]]
    for (const [phase, percent] of sequence) {
      const disk = { ...waitingDisk('x'), phase, percent }
      disk.overall_percent = overallProgress(disk, content, previous)
      assert.ok(disk.overall_percent >= previous.overall_percent, `${phase}: progress went backwards`)
      assert.equal(disk.overall_percent === 100, phase === 'completed', '100% is reserved for completion')
      previous = disk
    }
  }
  assert.equal(overallProgress({ ...waitingDisk('x'), phase: 'hashing', percent: 40 }, false), 35)
  assert.equal(overallProgress({ ...waitingDisk('x'), phase: 'discovering', percent: 40 }, false), 10)
  assert.equal(overallProgress({ ...waitingDisk('x'), phase: 'validating', percent: 100 }, false), 99.99)
  for (const status of ['stopped', 'interrupted', 'running', 'paused']) assert.equal(analysisFinished({ ...emptySnapshot(), status }), false)
  assert.equal(analysisFinished({ ...emptySnapshot(), status: 'error', error: 'ANALYZER_INTERRUPTED' }), false)
})
test('timing uses measured work, expires stalled estimates and excludes pauses and phase changes', () => {
  const { AnalysisTimingTracker } = require('../.verification/tests/electron/services/analysis-timing.js')
  const tracker = new AnalysisTimingTracker()
  const disk = { ...waitingDisk('x'), phase: 'hashing', percent: 0,
    work: { operation: 'hashing', current: 'large.bin', done: 0, total: 1000, unit: 'bytes', read_bytes: 0 } }
  assert.equal(tracker.observe(disk, false, true, 1000).eta_seconds, null)
  disk.work.done = 100; disk.work.read_bytes = 100
  const measured = tracker.observe(disk, false, true, 6000)
  assert.equal(measured.rate, 20)
  assert.equal(measured.eta_seconds, 45)
  assert.ok(measured.total_eta_seconds > measured.eta_seconds)
  assert.equal(tracker.observe(disk, false, true, 22000).eta_seconds, null)
  assert.equal(tracker.observe(disk, false, false, 23000).rate, null)
  assert.equal(tracker.observe(disk, false, true, 50000).eta_seconds, null)
  disk.work.done = 200
  assert.equal(tracker.observe(disk, false, true, 55000).rate, 20)
  disk.phase = 'comparing'; disk.work = { ...disk.work, operation: 'comparing', done: 0, total: 10, unit: 'files' }
  assert.equal(tracker.observe(disk, false, true, 56000).eta_seconds, null)
  disk.work.read_bytes += 100
  assert.equal(tracker.observe(disk, false, true, 61000).eta_seconds, null, 'Reading within an unfinished comparison is not zero seconds remaining')
  assert.ok(isDiskProgress({ ...disk, timing: measured }))
  assert.equal(isDiskProgress({ ...disk, work: { ...disk.work, done: 11 } }), false)
  assert.equal(isDiskProgress({ ...disk, timing: { ...measured, rate: Infinity } }), false)
})
test('job runs with incremental state, refuses arbitrary roots, persists separate private/public data', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.start({ ...f.request, roots: [f.directory] }), /DRIVE_UNAVAILABLE/)
  const phases = new Set()
  const percentages = [0, 0]
  f.service.on('snapshot', s => s.disks.forEach((d, i) => {
    phases.add(d.phase)
    assert.ok(d.overall_percent >= percentages[i], 'Live overall progress is monotonic')
    percentages[i] = d.overall_percent
  }))
  const start = await f.service.start(f.request)
  await assert.rejects(f.service.start(f.request), /ANALYSIS_BUSY/)
  const result = await until(f.service, s => ['completed', 'error'].includes(s.status))
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.total.duplicates, 1)
  assert.deepEqual(result.disks.map(d => d.duplicate_members), [1, 1])
  assert.equal(result.disks[0].empty, 1)
  assert.ok(phases.has('discovering') && phases.has('hashing') && phases.has('comparing'))
  const report = await f.service.report()
  assert.equal(report.complete, true)
  assert.ok(!JSON.stringify(report).includes('private.bin'))
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'app/reports', `${start.id}.json`)))
  assert.equal(saved.consentGrantId, f.consent.current().grantId)
  const reopened = f.make(); f.services.push(reopened)
  await reopened.restore()
  assert.equal(reopened.snapshot().status, 'completed')
  assert.equal(reopened.snapshot().total.duplicates, 1)
  assert.deepEqual(reopened.snapshot().disks.map(d => d.overall_percent), [100, 100])
  assert.equal((await fs.stat(path.join(f.directory, 'app/work/index.sqlite'))).isFile(), true)
})
test('pause, stop, service restart and explicit resume preserve job identity and revalidate files', async t => {
  const f = await fixture(t, 8 * 1024 * 1024)
  f.request.mode = 'low'
  const started = await f.service.start(f.request)
  await until(f.service, s => s.disks.some(d => d.phase === 'hashing'))
  await f.service.command('pause')
  assert.equal(f.service.snapshot().status, 'paused')
  await assert.rejects(f.service.command('pause'), /INVALID_ANALYSIS_STATE/)
  await f.service.command('resume')
  await f.service.command('stop')
  await f.service.shutdown()
  assert.equal(f.service.snapshot().status, 'stopped')
  const recovered = f.make(); f.services.push(recovered)
  await recovered.restore()
  assert.equal(recovered.snapshot().status, 'interrupted', 'Restore must never run automatically')
  assert.equal(recovered.snapshot().id, started.id)
  await fs.writeFile(path.join(f.roots[1], 'private.bin'), Buffer.alloc(8 * 1024 * 1024, 82))
  await recovered.command('resume')
  const result = await until(recovered, s => ['completed', 'error'].includes(s.status), 40000)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.id, started.id)
  assert.equal(result.total.duplicates, 0)
})
test('cleanup preserves interrupted work and exactly 5 MiB; removes only successful larger work', async t => {
  const f = await fixture(t, 16)
  const file = path.join(f.directory, 'threshold.sqlite')
  const handle = await fs.open(file, 'w'); await handle.truncate(WORK_FILE_THRESHOLD); await handle.close()
  await cleanupWorkFile(file, true)
  assert.equal((await fs.stat(file)).size, WORK_FILE_THRESHOLD)
  await fs.truncate(file, WORK_FILE_THRESHOLD + 1)
  await cleanupWorkFile(file, false)
  assert.equal((await fs.stat(file)).size, WORK_FILE_THRESHOLD + 1)
  await cleanupWorkFile(file, true)
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
})
test('state stays responsive in main while a real worker analyzes files', async t => {
  const { JobClient } = require('../.verification/tests/electron/services/job-client.js')
  const f = await fixture(t, 4 * 1024 * 1024)
  const client = new JobClient(path.join(__dirname, 'analysis-fixture-worker.cjs'), {
    executable: binary, directory: path.join(f.directory, 'app'), consentFile: path.join(f.directory, 'consent.json') })
  t.after(() => client.dispose())
  await client.ready
  await client.call('start', f.request)
  let samples = 0, maxMs = 0
  const timer = setInterval(() => {
    const started = performance.now(); const state = client.snapshot(); maxMs = Math.max(maxMs, performance.now() - started)
    assert.equal(state.id !== null, true); samples++
  }, 10)
  try {
    const completed = await until(client, s => ['completed', 'error'].includes(s.status))
    assert.equal(completed.status, 'completed', completed.error)
  } finally { clearInterval(timer) }
  assert.ok(samples > 10, 'Main continues responding while the worker runs')
  assert.ok(maxMs < 100, `Snapshot latency ${maxMs} ms exceeds the 100 ms budget`)
  console.log(`ANALYSIS_STATE_LATENCY: ${samples} samples, maximum ${maxMs.toFixed(3)} ms`)
})
test('content warnings survive service restart and statistics remain disabled after refusal', async t => {
  const f = await fixture(t, 16)
  f.consent.set({ enabled: false, noticeVersion: 2 })
  await fs.writeFile(path.join(f.roots[0], 'text.txt'), 'same text')
  await fs.writeFile(path.join(f.roots[1], 'text.md'), '**same**   text')
  const started = await f.service.start({ ...f.request, content: true })
  const result = await until(f.service, s => ['completed', 'error'].includes(s.status))
  assert.equal(result.status, 'completed', result.error)
  assert.deepEqual(result.warnings, { text: 1, image: 0, limited: 0 })
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'app/reports', `${started.id}.json`)))
  assert.equal(saved.consentGrantId, null)
  assert.equal('content' in saved.report, false)
  const restored = f.make(); f.services.push(restored); await restored.restore()
  assert.deepEqual(restored.snapshot().warnings, result.warnings)
})
test('missing drive produces a recoverable partial result; corrupt state never autostarts', async t => {
  const f = await fixture(t, 16)
  await fs.rm(f.roots[1], { recursive: true })
  await f.service.start(f.request)
  const result = await until(f.service, s => ['completed', 'error'].includes(s.status))
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'ANALYSIS_INCOMPLETE')
  assert.ok(analysisFinished(result))
  assert.deepEqual(result.disks.map(d => d.overall_percent), [100, 100])
  assert.equal(result.disks[1].issues[0].code, 'root_unavailable')
  assert.equal(result.disks[1].issues[0].examples[0], f.roots[1])
  assert.equal((await f.service.report()).complete, false)
  assert.equal(JSON.stringify(await f.service.report()).includes('root_unavailable'), false, 'Local diagnostics stay out of public report')
  await f.service.shutdown()
  // Migrate an old finished-with-errors snapshot that retained its last phase percentage.
  const stateFile = path.join(f.directory, 'app/job.json')
  const legacy = JSON.parse(await fs.readFile(stateFile, 'utf8'))
  legacy.disks.forEach(d => { d.overall_percent = 99.99; delete d.issues })
  await fs.writeFile(stateFile, JSON.stringify(legacy))
  const reopened = f.make(); f.services.push(reopened); await reopened.restore()
  assert.equal(reopened.snapshot().status, 'error')
  assert.equal(reopened.snapshot().error, 'ANALYSIS_INCOMPLETE')
  assert.deepEqual(reopened.snapshot().disks.map(d => d.overall_percent), [100, 100])
  await fs.writeFile(path.join(f.directory, 'app/job.json'), '{broken')
  const restored = f.make(); f.services.push(restored); await restored.restore()
  assert.equal(restored.snapshot().status, 'idle')
  assert.equal(restored.snapshot().error, 'JOB_RESTORE_FAILED')
})
test('a final result closes the command pipe before waiting for process exit', async t => {
  const { spawn } = require('node:child_process')
  const f = await fixture(t, 16)
  // This child forwards a real analyzer, then waits for EOF on its command
  // stream. A result must not leave the application stuck waiting for exit.
  const source = `
    const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), {stdio:['pipe','pipe','pipe']});
    let ended = false, code = null;
    function finish() { if (ended && code !== null) process.exit(code); }
    process.stdin.pipe(child.stdin);
    child.stdin.on('error', () => {});
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    process.stdin.on('end', () => { ended = true; finish(); });
    child.on('exit', value => { code = value ?? 1; finish(); });
  `
  const service = new JobService(binary, path.join(f.directory, 'eof'), path.join(f.directory, 'consent.json'),
    async () => f.roots.map(p => ({ path: p, name: 'synthetic', capacity: 1, available: 1 })),
    (executable, input) => spawn(process.execPath, ['-e', source, executable, '--job', input],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
  f.services.push(service)
  await service.start(f.request)
  const result = await until(service, s => ['completed', 'error'].includes(s.status))
  assert.equal(result.status, 'completed', result.error)
})

test('malformed or oversized analyzer output is bounded and cannot become a saved report', async t => {
  const { spawn } = require('node:child_process')
  const f = await fixture(t, 16)
  for (const [index, source, expected] of [
    [0, 'process.stdout.write("not JSON\\n"); setInterval(()=>{},1000)', 'INVALID_ANALYZER_EVENT'],
    [1, 'process.stdout.write("x".repeat(33*1024*1024)); setInterval(()=>{},1000)', 'ANALYZER_OUTPUT_LIMIT']
  ]) {
    const service = new JobService(binary, path.join(f.directory, `bad-${index}`), path.join(f.directory, 'consent.json'),
      async () => f.roots.map(p => ({ path: p, name: 'synthetic', capacity: 1, available: 1 })),
      () => spawn(process.execPath, ['-e', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
    f.services.push(service)
    await service.start(f.request)
    const result = await until(service, s => s.status === 'error')
    assert.equal(result.error, expected)
    assert.equal(await service.report(), null)
  }
})
