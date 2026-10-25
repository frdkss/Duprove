const { app, BrowserWindow, ipcMain, shell, protocol } = require('electron')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const directory = path.join(root, '.verification', `results-ui-${randomUUID()}`)
app.setPath('userData', path.join(directory, 'profile'))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'duprove-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
const timer = setTimeout(() => { console.error('RESULTS_UI_TIMEOUT'); app.exit(1) }, 120000)
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true })
  const { CatalogService } = require('../.verification/tests/electron/services/catalog-service.js')
  const { TrashService } = require('../.verification/tests/electron/services/trash-service.js')
  const { ComparisonWindows } = require('../.verification/tests/electron/comparison-windows.js')
  const catalog = new CatalogService(directory, 'simulated-native-preview', async (_exe, request) => request.action === 'snapshot'
    ? (await fs.copyFile(request.path, request.output), { status: 'ready', sha256: 'a'.repeat(64) }) : request.action === 'pair'
    ? { status: 'ready', sha256: 'a'.repeat(64), otherSha256: 'a'.repeat(64), equal: true }
    : { status: 'ready', kind: 'text', text: '<script>globalThis.PREVIEW_EXECUTED=true</script>\nLiteral text preview', sha256: 'a'.repeat(64), truncated: false })
  const analysisId = randomUUID()
  const source = path.join(directory, 'work.sqlite')
  const db = new DatabaseSync(source)
  db.exec('CREATE TABLE files(path TEXT,identity TEXT,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER,hash TEXT,gid INTEGER);')
  const insert = db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)')
  const names = []
  for (let i = 1; i <= 60; i++) {
    const name = path.join(directory, 'каталог-с-длинным-именем-для-проверки-переноса-строк', `отдельный-каталог-${i}`, i === 1 ? 'первый-экземпляр.txt' : i === 3 ? '.gitignore' : 'одинаковое-имя.txt')
    names.push(name)
    await fs.mkdir(path.dirname(name), { recursive: true }); await fs.writeFile(name, 'abc')
    insert.run(name, 'id:' + i, i % 2, 3, 1, 2, 'a'.repeat(64), 1)
  }
  for (let gid = 2; gid <= 30; gid++) for (let i = 1; i <= 2; i++) insert.run(path.join(directory, `${gid}-${i}.txt`), `${gid}:${i}`, i % 2, 3, 1, 2, 'a'.repeat(64), gid)
  db.close()
  await catalog.capture(source, analysisId, [directory], false)
  const { emptySnapshot, waitingDisk } = require('../.verification/tests/contracts/analysis.js')
  const drives = [{ path: directory, name: 'Тестовый диск', capacity: 1024 ** 3, available: 512 * 1024 ** 2 }]
  const analysis = { ...emptySnapshot(), id: analysisId, status: 'completed', revision: 1, drives,
    disks: drives.map(d => ({ ...waitingDisk(d.path), phase: 'completed', percent: 100, overall_percent: 100 })) }
  ipcMain.handle('duprove:analysis:get', () => analysis)
  const comparisons = new ComparisonWindows((method, value) => ({ comparison: () => catalog.comparison(value), comparisonFile: () => catalog.comparisonFile(value), comparisonClose: () => catalog.clearComparison(value) })[method](), {
    preload: path.join(root, 'dist-electron/preload.js'), index: path.join(root, 'dist/index.html'), show: false, busy: () => trash.busy,
  })
  protocol.handle('duprove-preview', request => comparisons.response(request))
  ipcMain.handle('duprove:comparison:open', (event, request) => comparisons.open(request, BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('duprove:comparison:get', event => comparisons.get(event.sender.id))
  ipcMain.handle('duprove:comparison:file', (event, id) => comparisons.document(event.sender.id, id))
  ipcMain.handle('duprove:catalog', async (_event, request) => {
    const result = await catalog.request(request)
    if (['original', 'decision'].includes(request.action)) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('duprove:catalog:event', { analysisId, groupId: request.groupId })
      await comparisons.changed(analysisId, request.groupId, request.action === 'original')
    }
    return result
  })
  const confirmationResults = [false, true]
  const trash = new TrashService((method, value) => ({ trashPrepare: () => catalog.prepareTrash(value), trashVerify: () => catalog.verifyTrash(value), trashRecord: () => catalog.recordTrash(value), trashRelease: () => catalog.releaseTrash(value) })[method](),
    async plan => { assert.deepEqual(plan.entries.map(entry => entry.path), [names[1], names[2]]); return confirmationResults.shift() ?? false }, file => shell.trashItem(file), () => false)
  ipcMain.handle('duprove:trash', (_event, request) => trash.run(request))
  ipcMain.handle('duprove:drives', () => [])
  ipcMain.handle('duprove:update:get', () => ({ revision: 0, status: 'idle' }))
  ipcMain.handle('duprove:delivery:get', () => ({ revision: 0, configured: false }))
  const windowActions = []
  ipcMain.handle('duprove:window', (event, action) => {
    if (event.sender === window.webContents) windowActions.push(action)
    else if (action === 'close') BrowserWindow.fromWebContents(event.sender).close()
  })
  const window = new BrowserWindow({ show: false, frame: false, width: 1280, height: 800, enableLargerThanScreen: true, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false,
  } })
  let latestFrame
  window.webContents.on('paint', (_event, _dirty, image) => { latestFrame = image })
  const evaluate = s => window.webContents.executeJavaScript(s)
  const waitFor = async s => {
    const until = Date.now() + 5000
    while (!await evaluate(s)) { if (Date.now() > until) throw Error('UI_CONDITION: ' + s); await new Promise(r => setTimeout(r, 35)) }
  }
  const click = async s => { await evaluate(`document.querySelector(${JSON.stringify(s)}).click()`); await new Promise(r => setTimeout(r, 60)) }
  const textButton = async text => { await evaluate(`(() => { const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}); b.focus(); b.click(); })()`); await new Promise(r => setTimeout(r, 100)) }
  const resize = async (width, height) => {
    const scale = await evaluate('devicePixelRatio')
    return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.webContents.removeListener('paint', painted)
      reject(Error(`RESULTS_RESIZE_TIMEOUT: requested=${width}x${height}; window=${window.getSize().join('x')}; frame=${JSON.stringify(latestFrame?.getSize())}; scale=${scale}`))
    }, 5000)
    const painted = (_event, _dirty, image) => {
      if (![width, Math.round(width * scale)].includes(image.getSize().width)) return
      clearTimeout(timeout); window.webContents.removeListener('paint', painted); resolve()
    }
    window.webContents.on('paint', painted); window.setSize(width, height); window.webContents.invalidate()
    })
  }
  await window.loadFile(path.join(root, 'dist/index.html'))
  await waitFor(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Группы файлов')`)
  await textButton('Группы файлов')
  await waitFor(`document.querySelectorAll('.result-member').length===25`)
  console.log('RESULTS_UI: loaded')
  await assert.rejects(evaluate(`window.duprove.trashCatalog({ analysisId:${JSON.stringify(analysisId)}, groupId:'e:1', fileIds:[1], path:'arbitrary-renderer-path' })`), /INVALID_TRASH_REQUEST/)
  assert.equal(await evaluate(`document.querySelector('.results-dialog header p')`), null)
  assert.equal(await evaluate(`document.querySelector('.results-dialog footer')`), null)
  assert.equal(await evaluate(`document.querySelector('.results-dialog header .results-tabs') !== null`), true)
  assert.equal(await evaluate(`document.querySelector('.results-dialog > .results-note')`), null)
  assert.equal(await evaluate(`document.querySelector('.result-member-controls select').closest('label')`), null, 'Decision keeps its accessible name without the visible caption')
  assert.equal(await evaluate(`document.querySelector('.result-group strong').textContent`), 'одинаковое-имя.txt')
  assert.equal(await evaluate(`document.querySelector('.result-group').title`), 'одинаковое-имя.txt')
  assert.equal(await evaluate(`document.querySelector('.results-members h3').textContent`), 'Точные дубликаты · одинаковое-имя.txt')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.result-group-meta span'), s=>s.textContent).slice(0,2)`), ['60 файлов', '180 байт'])
  assert.equal(await evaluate(`(() => { const name=document.querySelector('.result-group strong'), meta=document.querySelector('.result-group-meta'); return Number(getComputedStyle(meta).opacity)<1 && parseFloat(getComputedStyle(meta).fontSize)<parseFloat(getComputedStyle(name).fontSize); })()`), true)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Закрыть группы')
  const appClosePoint = await evaluate(`(() => { const button=document.querySelector('.window-close'), r=button.getBoundingClientRect(), x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2); if(document.elementFromPoint(x,y)?.closest('button')!==button) throw Error('APP_CLOSE_BLOCKED'); return {x,y}; })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...appClosePoint })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...appClosePoint })
  const closeUntil = Date.now() + 5000
  while (!windowActions.length && Date.now() < closeUntil) await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(windowActions, ['close'], 'The app close button receives a real click while groups are open')
  assert.equal(await evaluate(`document.querySelector('.app-body').inert`), true)
  assert.equal(await evaluate(`document.querySelector('.result-member-name').textContent`), 'первый-экземпляр.txt')
  assert.equal(await evaluate(`document.querySelectorAll('.result-member-name')[2].textContent`), '.gitignore')
  assert.equal(await evaluate(`document.querySelector('.result-member-info p:last-child').textContent`), '3 байт')
  assert.equal(await evaluate(`document.querySelectorAll('.result-member-selection').length`), 25)
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('.result-member-controls').querySelectorAll('button'), b => b.textContent)`), ['Открыть', 'Сравнить с оригиналом', 'Копировать путь'])
  assert.equal(await evaluate(`document.querySelector('.result-compare').disabled`), true)
  await resize(1920, 1080)
  assert.deepEqual(await evaluate(`(() => { const r=document.querySelector('.result-member-selection').getBoundingClientRect(); return [r.width,r.height]; })()`), [28,28])
  await evaluate(`document.documentElement.dataset.theme='dark'`)
  await new Promise(r => setTimeout(r, 180))
  await fs.writeFile(path.join(root, '.verification/results-card-dark-1920x1080.png'), latestFrame.toPNG())
  await resize(640, 480)
  await new Promise(r => setTimeout(r, 180))
  await fs.writeFile(path.join(root, '.verification/results-card-dark-640x480.png'), latestFrame.toPNG())
  await resize(1920, 1080)
  await click('.result-member-selection')
  assert.equal(await evaluate(`document.querySelector('.result-member-selection').checked`), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Перенести отмеченные на странице в корзину').disabled`), true, 'Selection alone does not authorize deleting an undecided file')
  assert.equal(await evaluate(`document.querySelectorAll('.result-original input:checked').length`), 0)
  await evaluate(`document.querySelector('.result-original input').focus()`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await waitFor(`document.querySelector('.result-original input')?.checked`)
  await waitFor(`!document.querySelector('.result-member-selection')?.disabled && document.querySelector('.result-member-selection').checked`)
  await click('.result-member-selection')
  console.log('RESULTS_UI: original selected')
  assert.equal((await catalog.request({ action: 'groups', analysisId, kind: 'exact', offset: 0 })).items[0].originalId, 1)
  const waitComparison = async count => {
    const until = Date.now() + 10000
    let child
    while (Date.now() < until) {
      child = BrowserWindow.getAllWindows().find(candidate => candidate !== window)
      if (child && await child.webContents.executeJavaScript(`document.querySelectorAll('textarea').length===${count}`).catch(() => false)) return child
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw Error('COMPARISON_NOT_READY: expected ' + count + ' documents')
  }
  await textButton('Открыть')
  const single = await waitComparison(1)
  await single.webContents.executeJavaScript(`void window.duprove.windowAction('close')`)
  await new Promise(resolve => setTimeout(resolve, 100))
  await click('.result-member:nth-of-type(1) .result-member-selection')
  await click('.result-member:nth-of-type(2) .result-member-selection')
  await click('.result-member:nth-of-type(3) .result-member-selection')
  await textButton('Сравнить выделенные (3)')
  const multiple = await waitComparison(3)
  assert.deepEqual(comparisons.get(multiple.webContents.id).files.map(file => file.id), [1, 2, 3])
  await multiple.webContents.executeJavaScript(`void window.duprove.windowAction('close')`)
  await new Promise(resolve => setTimeout(resolve, 100))
  await click('.result-member:nth-of-type(1) .result-member-selection')
  await click('.result-member:nth-of-type(3) .result-member-selection')
  await click('[aria-label="Страницы участников: далее"]')
  await waitFor(`document.querySelector('.result-path')?.textContent.includes('каталог-26')`)
  assert.equal(await evaluate(`document.querySelectorAll('.result-member-selection:checked').length`), 0, 'Selection belongs to the current page')
  await click('[aria-label="Страницы участников: далее"]')
  await waitFor(`document.querySelectorAll('.result-member').length===10`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Страницы участников: далее"]').disabled`), true)
  await click('[aria-label="Страницы участников: назад"]')
  await click('[aria-label="Страницы участников: назад"]')
  await waitFor(`document.querySelector('.result-original input')?.checked`)
  await click('.result-member:nth-of-type(2) .result-member-selection')
  await evaluate(`Array.from(document.querySelectorAll('.result-member'))[1].querySelector('.result-compare').click()`)
  const child = BrowserWindow.getAllWindows().find(candidate => candidate !== window)
  const childEvaluate = script => child.webContents.executeJavaScript(script)
  const childUntil = Date.now() + 10000
  while (!await childEvaluate(`document.querySelectorAll('textarea').length===2 && !document.querySelector('.comparison-file-actions button:last-child')?.disabled`)) {
    if (Date.now() > childUntil) throw Error('COMPARISON_CHILD_NOT_READY: ' + await childEvaluate('document.body.innerText'))
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.equal(await childEvaluate('globalThis.PREVIEW_EXECUTED'), undefined)
  assert.equal(await childEvaluate(`document.querySelector('textarea').value`), 'abc')
  assert.equal(await evaluate(`document.querySelector('.file-preview')`), null, 'Comparison is not embedded in the results dialog')
  await childEvaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Проверено: отметить для удаления').click()`)
  await waitFor(`Array.from(document.querySelectorAll('.result-member'))[1]?.querySelector('select')?.value === 'delete'`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.result-member'))[1].querySelector('.result-member-selection').checked`), true, 'Selection survives decision updates')
  await childEvaluate(`void window.duprove.windowAction('close')`)
  await click('.result-member:nth-of-type(2) .result-member-selection')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Перенести отмеченные на странице в корзину').disabled`), true, 'Unselected marked files are excluded from bulk transfer')
  await click('.result-member:nth-of-type(2) .result-member-selection')
  await click('.result-member:nth-of-type(3) .result-member-selection')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Перенести отмеченные на странице в корзину').disabled`), false, 'Exact duplicates can be transferred directly from selection after choosing an original')
  await click('.result-member:nth-of-type(3) .result-member-selection')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Перенести отмеченные на странице в корзину').disabled`), false)
  assert.equal(await fs.readFile(names[1], 'utf8'), 'abc', 'a verdict does not delete the disposable file')
  for (const theme of ['light', 'dark']) for (const [width, height] of [[640,480],[960,640],[1280,800],[1920,1080]]) {
    await resize(width, height)
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
    await new Promise(r => setTimeout(r, 180))
    assert.deepEqual(await evaluate(`(() => {
      const d=document.querySelector('.results-dialog'), r=d.getBoundingClientRect();
      const problems=[];
      if(r.left<0||r.right>innerWidth+1||r.bottom>innerHeight+1) problems.push('dialog outside viewport');
      const bar=document.querySelector('.title-bar').getBoundingClientRect(), appClose=document.querySelector('.window-close'), closeBounds=appClose.getBoundingClientRect();
      if(r.top<bar.bottom+8) problems.push('dialog must leave room for the title bar');
      if(document.elementFromPoint(closeBounds.left+closeBounds.width/2,closeBounds.top+closeBounds.height/2)?.closest('button')!==appClose) problems.push('app close button is blocked');
      if(r.width<innerWidth-48||r.height<innerHeight-bar.height-48) problems.push('dialog must use the available window');
      if(d.scrollWidth>d.clientWidth+1) problems.push('dialog horizontal overflow');
      for(const el of d.querySelectorAll('.results-members,.results-groups')) if(el.scrollWidth>el.clientWidth+1) problems.push(el.className+' overflow');
      if(innerWidth>=960) {
        const group=d.querySelector('.result-group'), title=group.querySelector('strong').getBoundingClientRect(), count=group.querySelector('.result-group-meta').getBoundingClientRect();
        if(count.left<title.right||Math.abs((count.top+count.bottom-title.top-title.bottom)/2)>4) problems.push('group details must stay beside the filename');
      }
      if(innerWidth>=1280) {
        const member=d.querySelector('.result-member'), card=member.getBoundingClientRect(), original=member.querySelector('.result-original').getBoundingClientRect(), controls=member.querySelector('.result-member-controls').getBoundingClientRect(), name=member.querySelector('.result-member-name').getBoundingClientRect(), selection=member.querySelector('.result-member-selection').getBoundingClientRect();
        if(controls.left<name.right||original.top<controls.bottom||Math.abs(original.right-controls.right)>2) problems.push('member actions must stay above the original choice on the right');
        if(selection.right>=name.left||card.height<140||card.height>200) problems.push('member must keep left selection and roomier spacing');
      }
      const cards=Array.from(d.querySelectorAll('.result-member')).slice(0,3), colors=cards.map(card=>getComputedStyle(card).backgroundColor);
      if(new Set(colors).size!==3) problems.push('original, selected and ordinary cards must have distinct colors');
      if(parseFloat(getComputedStyle(cards[0]).marginBottom)<16) problems.push('cards need larger vertical gaps');
      return problems;
    })()`), [], `${theme} ${width}x${height}`)
    assert.ok([width, Math.round(width * await evaluate('devicePixelRatio'))].includes(latestFrame?.getSize().width), 'screenshot comes from the resized Electron paint event')
    await fs.writeFile(path.join(root, `.verification/results-${theme}-${width}x${height}.png`), latestFrame.toPNG())
    console.log(`RESULTS_UI: ${theme} ${width}x${height}`)
  }
  await click('.result-member:nth-of-type(3) .result-member-selection')
  await textButton('Перенести отмеченные на странице в корзину')
  await waitFor(`document.querySelector('.results-dialog [role="status"]')?.textContent.includes('Перенос отменён')`)
  assert.equal(await fs.readFile(names[1], 'utf8'), 'abc')
  await textButton('Перенести отмеченные на странице в корзину')
  await waitFor(`Array.from(document.querySelectorAll('.result-member'))[1]?.textContent.includes('В корзине')`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.result-member'))[1].querySelector('.result-member-selection').disabled`), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.result-member'))[1].querySelector('.result-member-selection').checked`), false)
  await assert.rejects(fs.stat(names[1]), /ENOENT/)
  await assert.rejects(fs.stat(names[2]), /ENOENT/)
  assert.equal(await fs.readFile(names[0], 'utf8'), 'abc')
  assert.equal(confirmationResults.length, 0)
  console.log('RESULTS_UI: actual OS recycle-bin transfer of two selected files verified; confirmation/native content proofs simulated')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(`!document.querySelector('.results-dialog')`)
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Группы файлов')
  await textButton('Группы файлов'); await waitFor(`document.querySelector('.result-original input')?.checked`)
  await click('[aria-label="Закрыть группы"]')
  await fs.unlink(catalog.file)
  await textButton('Группы файлов')
  await waitFor(`document.querySelector('.results-error')?.textContent.includes('новый анализ')`)
  clearTimeout(timer)
  await fs.writeFile(path.join(root, '.verification/results-ui-report.json'), JSON.stringify({ analysisId, passed: true, themes: ['light','dark'], sizes: ['640x480','960x640','1280x800','1920x1080'], fixtures: 'synthetic SQLite catalog and disposable files; real Electron/preload/React and separate comparison window; simulated native preview and confirmation answers', trash: 'real shell.trashItem on two selected disposable fixtures; original preserved; cancellation verified' }, null, 2))
  console.log('RESULTS_UI_OK'); window.destroy(); app.exit(0)
}).catch(e => { clearTimeout(timer); console.error(e); app.exit(1) })
