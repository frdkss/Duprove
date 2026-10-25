// Real native scan and checked snapshots -> production preload/protocol -> real format readers.
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { fixtures } = require('./comparison-fixtures.cjs')
const root = path.resolve(__dirname, '..'), directory = path.join(root, '.verification', 'comparison-window-' + randomUUID())
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'duprove-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
const deadline = setTimeout(() => { console.error('COMPARISON_WINDOW_TIMEOUT'); app.exit(1) }, 180000)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function scan(binary, job) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--job', job], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''; child.stderr.on('data', bytes => { error += bytes.toString().slice(0, 500) })
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error('SCAN_FAILED ' + code + ' ' + error)))
    child.stdin.end()
  })
}
app.whenReady().then(async () => {
  const { CatalogService } = require('../.verification/tests/electron/services/catalog-service.js')
  const { ComparisonWindows } = require('../.verification/tests/electron/comparison-windows.js')
  const { TrashService } = require('../.verification/tests/electron/services/trash-service.js')
  const binary = process.env.DUPROVE_ANALYZER || path.join(root, 'build/native/bin', process.platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
  const privateDirectory = path.join(directory, 'private'), inputRoot = path.join(directory, 'files'), database = path.join(privateDirectory, 'work/index.sqlite')
  const data = await fixtures(), paths = []
  for (const [name, bytes] of Object.entries(data)) for (let copy = 0; copy < (name === 'source.py' ? 6 : 2); copy++) {
    const file = path.join(inputRoot, String(copy), name)
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); paths.push(file)
  }
  const job = path.join(directory, 'job.json')
  await fs.writeFile(job, JSON.stringify({ roots: [inputRoot], database, private_directory: privateDirectory, load: 2, content: false }))
  await scan(binary, job)
  const catalog = new CatalogService(privateDirectory, binary), analysisId = randomUUID()
  await catalog.capture(database, analysisId, [inputRoot], true)
  const groups = (await catalog.request({ action: 'groups', analysisId, kind: 'exact', offset: 0 })).items, byName = new Map()
  for (const group of groups) {
    const members = (await catalog.request({ action: 'members', analysisId, groupId: group.id, offset: 0 })).items
    byName.set(members[0].name, { group, members })
    await catalog.request({ action: 'original', analysisId, groupId: group.id, fileId: members[0].id })
  }
  assert.equal(byName.size, Object.keys(data).length)
  const { emptySnapshot, waitingDisk } = require('../.verification/tests/contracts/analysis.js')
  const drive = { path: inputRoot, name: 'Comparison fixtures', capacity: 1024 ** 3, available: 512 * 1024 ** 2 }
  ipcMain.handle('duprove:analysis:get', () => ({ ...emptySnapshot(), id: analysisId, status: 'completed', revision: 1, drives: [drive], disks: [{ ...waitingDisk(inputRoot), phase: 'completed', percent: 100, overall_percent: 100 }] }))
  ipcMain.handle('duprove:drives', () => [])
  ipcMain.handle('duprove:update:get', () => ({ revision: 0, status: 'idle' }))
  ipcMain.handle('duprove:delivery:get', () => ({ revision: 0, configured: false }))
  ipcMain.handle('duprove:window', (event, action) => { const window = BrowserWindow.fromWebContents(event.sender); if (action === 'close') window.close() })
  const manager = new ComparisonWindows((method, value) => ({ comparison: () => catalog.comparison(value), comparisonFile: () => catalog.comparisonFile(value), comparisonClose: () => catalog.clearComparison(value) })[method](), {
    preload: path.join(root, 'dist-electron/preload.js'), index: path.join(root, 'dist/index.html'), show: false, busy: () => false,
  })
  protocol.handle('duprove-preview', request => manager.response(request))
  ipcMain.handle('duprove:comparison:open', (event, request) => manager.open(request, BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('duprove:comparison:get', event => manager.get(event.sender.id))
  ipcMain.handle('duprove:comparison:file', (event, id) => manager.document(event.sender.id, id))
  ipcMain.handle('duprove:catalog', async (_event, request) => {
    const result = await catalog.request(request)
    if (['original', 'decision'].includes(request.action)) await manager.changed(request.analysisId, request.groupId, request.action === 'original')
    return result
  })
  const confirmationAnswers = [false, true], confirmedPaths = []
  const trash = new TrashService((method, value) => ({ trashPrepare: () => catalog.prepareTrash(value), trashVerify: () => catalog.verifyTrash(value), trashRecord: () => catalog.recordTrash(value), trashRelease: () => catalog.releaseTrash(value) })[method](), async plan => {
    assert.equal(plan.entries.length, 2); confirmedPaths.push(plan.entries.map(entry => entry.path)); return confirmationAnswers.shift()
  }, async (file, lease) => { if (process.platform === 'win32') await catalog.executeTrash(lease); else await require('electron').shell.trashItem(file) }, () => false)
  ipcMain.handle('duprove:trash', (_event, request) => trash.run(request))
  const parent = new BrowserWindow({ show: false, frame: false, webPreferences: { preload: path.join(root, 'dist-electron/preload.js'), contextIsolation: true, sandbox: true, offscreen: true } })
  await parent.loadFile(path.join(root, 'dist/index.html'))
  let child, evaluate, latestFrame
  const waitFor = async (code, timeout = 15000) => {
    const until = Date.now() + timeout
    while (!await evaluate(code)) {
      if (Date.now() > until) throw Error('CONDITION_TIMEOUT: ' + code + '\n' + await evaluate('document.body.innerText'))
      await delay(40)
    }
  }
  const passed = []
  for (const [name] of Object.entries(data)) {
    const { group, members } = byName.get(name), ids = members.slice(0, 2).map(m => m.id)
    await parent.webContents.executeJavaScript(`window.duprove.openComparison(${JSON.stringify({ analysisId, groupId: group.id, fileIds: ids })})`)
    const windows = BrowserWindow.getAllWindows(), previous = child; child = windows.find(window => window !== parent)
    if (child !== previous) child.webContents.on('paint', (_event, _dirty, image) => { latestFrame = image })
    assert.equal(windows.length, 2, 'Comparison uses one separate window')
    evaluate = code => child.webContents.executeJavaScript(code)
    child.setSize(1280, 800)
    await waitFor(`document.querySelectorAll('.comparison-column').length === 2 && document.querySelector('.comparison-file-heading h2')?.textContent === ${JSON.stringify(name)} && document.querySelector('.comparison-column:nth-child(2) .comparison-file-actions button:last-child')?.disabled === false`)
    manager.get(child.webContents.id)
    assert.throws(() => manager.get(parent.webContents.id), /INVALID_COMPARISON_WINDOW/)
    await assert.rejects(manager.document(child.webContents.id, 9999999), /INVALID_COMPARISON_FILE/)
    assert.equal((await manager.response(new Request('duprove-preview://' + randomUUID() + '/' + ids[0]))).status, 404)
    const loaded = await manager.document(child.webContents.id, ids[0])
    assert.equal(loaded.snapshot, undefined); assert.equal(loaded.sha256, undefined)
    if (/\.py$|\.json$/.test(name)) {
      await waitFor(`document.querySelectorAll('textarea').length === 2 && document.querySelector('textarea').value.includes('<script>')`)
      assert.equal(await evaluate('globalThis.PREVIEW_EXECUTED'), undefined)
      assert.equal(await evaluate('document.querySelector("textarea").readOnly'), true)
    } else if (name.endsWith('.pdf')) {
      await waitFor(`document.querySelector('.pdf-page-text')?.textContent.includes('Comparison PDF page 1')`)
      assert.ok(await evaluate(`document.querySelector('.pdf-pages canvas').width > 100`))
      await evaluate(`document.querySelector('.pdf-viewer .viewer-toolbar button:nth-of-type(2)').click()`)
      await waitFor(`document.querySelector('.pdf-page-text')?.textContent.includes('Comparison PDF page 2')`)
    } else if (name.endsWith('.wav')) {
      await waitFor(`document.querySelector('audio')?.duration > 1.9`)
      await evaluate(`(async () => {const audio=document.querySelector('audio');audio.muted=true;await audio.play();audio.currentTime=1;})()`)
      await waitFor(`document.querySelector('audio').currentTime >= 1`)
      await evaluate(`document.querySelector('audio').pause()`)
    } else if (/\.(png|svg|tiff)$/.test(name)) {
      await waitFor(`document.querySelector('.image-stage img')?.naturalWidth > 0`)
      assert.equal(await evaluate('globalThis.PREVIEW_EXECUTED'), undefined)
      assert.equal(await evaluate(`document.querySelector('.image-stage img').naturalWidth`), name.endsWith('.tiff') ? 2 : name.endsWith('.svg') ? 80 : 1)
    } else if (/\.(docx|doc|rtf)$/.test(name)) {
      const marker = name.endsWith('.docx') ? 'Comparison Word document' : name.endsWith('.rtf') ? 'Comparison RTF document' : 'Unicode characters'
      await waitFor(`document.querySelector('.word-document')?.shadowRoot?.textContent.includes(${JSON.stringify(marker)})`)
      if (name.endsWith('.docx')) assert.ok(await evaluate(`document.querySelector('.word-document').shadowRoot.querySelector('section.docx') !== null`))
    } else {
      await waitFor(`document.querySelector('.sheet-stage')?.textContent.includes('Comparison sheet') && document.querySelector('.sheet-stage')?.textContent.includes('42')`)
      await evaluate(`(() => {const select=document.querySelector('[aria-label="Лист таблицы"]');select.value='Second';select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
      await waitFor(`document.querySelector('.sheet-stage')?.textContent.includes('Second sheet marker')`)
    }
    assert.equal(await evaluate('globalThis.PREVIEW_EXECUTED'), undefined)
    passed.push(name); console.log('COMPARISON_FORMAT_OK ' + name)
  }
  const { group, members } = byName.get('source.py'), ids = members.map(m => m.id)
  await parent.webContents.executeJavaScript(`window.duprove.openComparison(${JSON.stringify({ analysisId, groupId: group.id, fileIds: ids })})`)
  await waitFor(`document.querySelectorAll('.comparison-column').length === 6`)
  for (const [width, height, columns] of [[1920, 1080, 4], [1366, 768, 3], [1280, 720, 2], [640, 480, 1]]) {
    child.setSize(width, height)
    await waitFor(`innerWidth === ${width} && getComputedStyle(document.querySelector('.comparison-board')).getPropertyValue('--comparison-columns').trim() === '${columns}'`)
    await waitFor(`Array.from(document.querySelectorAll('.comparison-column')).slice(0,${columns}).every(card=>card.querySelector('textarea')?.value.includes('Привет'))`)
    const measurements = await evaluate(`(() => { const board=document.querySelector('.comparison-board'), card=board.firstElementChild, close=document.querySelector('.window-close'), r=close.getBoundingClientRect();return {scroll:board.scrollWidth>board.clientWidth+100, width:card.getBoundingClientRect().width, client:board.clientWidth, close:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===close}; })()`)
    assert.ok(measurements.scroll); assert.ok(measurements.close)
    assert.ok(measurements.width * columns <= measurements.client)
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.webContents.removeListener('paint', painted); reject(Error('COMPARISON_PAINT_TIMEOUT')) }, 5000)
      const painted = (_event, _dirty, image) => { if (image.getSize().width === width) { clearTimeout(timeout); child.webContents.removeListener('paint', painted); resolve() } }
      child.webContents.on('paint', painted); child.webContents.invalidate()
    })
    assert.equal(latestFrame?.getSize().width, width, 'Screenshot uses the resized offscreen paint')
    await fs.writeFile(path.join(root, `.verification/comparison-${width}x${height}.png`), latestFrame.toPNG())
    console.log(`COMPARISON_LAYOUT_OK ${width}x${height} columns=${columns}`)
  }
  await evaluate(`document.querySelector('.comparison-board').scrollLeft=100000`)
  await waitFor(`document.querySelector('.comparison-column:last-child textarea')?.value.includes('Привет')`)
  const session = manager.get(child.webContents.id).sessionId
  await evaluate(`void window.duprove.windowAction('close')`)
  await delay(250)
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Child title-bar close leaves parent open')
  assert.equal((await manager.response(new Request('duprove-preview://' + session + '/' + ids[0]))).status, 404)
  await catalog.clearComparison()
  assert.deepEqual(await fs.readdir(path.join(privateDirectory, 'preview-cache')), [])
  for (const file of paths) assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), createHash('sha256').update(data[path.basename(file)]).digest('hex'), 'Source is unchanged')
  evaluate = code => parent.webContents.executeJavaScript(code)
  await waitFor(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Группы файлов')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Группы файлов').click()`)
  await waitFor(`Array.from(document.querySelectorAll('.result-group strong')).some(name=>name.textContent==='source.py')`)
  await evaluate(`Array.from(document.querySelectorAll('.result-group')).find(button=>button.querySelector('strong').textContent==='source.py').click()`)
  await waitFor(`document.querySelectorAll('.result-member').length===6 && document.querySelector('.result-original input')?.checked`)
  await evaluate(`document.querySelectorAll('.result-member-selection')[1].click();document.querySelectorAll('.result-member-selection')[2].click()`)
  const bulk = `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Перенести отмеченные на странице в корзину')`
  await waitFor(`${bulk}?.disabled === false`)
  await evaluate(`${bulk}.click()`)
  await waitFor(`document.querySelector('.results-dialog [role=status]')?.textContent.includes('Перенос отменён')`)
  for (const file of confirmedPaths[0]) assert.ok(await fs.stat(file))
  await evaluate(`${bulk}.click()`)
  await waitFor(`document.querySelector('.results-dialog [role=status]')?.textContent.includes('В корзине: 2. Ошибок: 0.')`)
  for (const file of confirmedPaths[1]) await assert.rejects(fs.stat(file), /ENOENT/)
  assert.equal(await fs.readFile(members[0].path, 'utf8'), data['source.py'].toString('utf8'), 'Original survives native bulk transfer')
  assert.equal(confirmationAnswers.length, 0)
  console.log('COMPARISON_BULK_OK real UI selection -> native verification -> OS recycle bin; two files; original retained; cancel verified')
  await fs.writeFile(path.join(root, '.verification/comparison-window-report.json'), JSON.stringify({ passed: true, nativeScan: 'real', snapshotIdentityAndHashes: 'real', viewers: passed, separateWindow: true, visibleColumns: { fhd: 4, hd1366: 3, hd1280: 2 }, horizontalScroll: true, scriptsExecuted: false, cacheCleared: true, originalsUnchanged: true, bulkTrash: { files: 2, nativeVerification: 'real', osAdapter: 'real', confirmationAnswers: 'injected cancel and accept', originalRetained: true } }, null, 2))
  clearTimeout(deadline); console.log('COMPARISON_WINDOW_OK'); parent.destroy(); app.exit(0)
}).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1) })
