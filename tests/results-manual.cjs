// Visible disposable fixture for manual pointer/keyboard and native cancellation checks.
// Native file proofs are simulated; this harness never transfers files.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('node:fs/promises')
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const directory = path.join(root, '.verification', 'manual-results-' + randomUUID())
app.setPath('userData', path.join(directory, 'profile'))
app.whenReady().then(async () => {
  const { CatalogService } = require('../.verification/tests/electron/services/catalog-service.js')
  const { TrashService } = require('../.verification/tests/electron/services/trash-service.js')
  const { trashConfirmationOptions } = require('../.verification/tests/electron/services/trash-confirmation.js')
  const { emptySnapshot } = require('../.verification/tests/contracts/analysis.js')
  await fs.mkdir(directory, { recursive: true })
  const source = path.join(directory, 'source.sqlite'), db = new DatabaseSync(source)
  db.exec('CREATE TABLE files(path TEXT,identity TEXT,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER,hash TEXT,gid INTEGER);')
  const files = []
  for (let n = 1; n <= 3; n++) {
    const file = path.join(directory, `отдельный-каталог-${n}`, 'пример.txt'); files.push(file)
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'abc')
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)').run(file, 'id:' + n, 0, 3, 1, 2, 'a'.repeat(64), 1)
  }
  db.close()
  const analysisId = randomUUID()
  const catalog = new CatalogService(directory, 'simulated-native-proof', async (_exe, request) => request.action === 'pair'
    ? { status: 'ready', sha256: 'a'.repeat(64), otherSha256: 'a'.repeat(64), equal: true }
    : { status: 'ready', sha256: 'a'.repeat(64), kind: 'text', text: '<script>Этот текст не исполняется</script>\nПример предпросмотра.', truncated: false })
  await catalog.capture(source, analysisId, [directory], true)
  const log = { directory, analysisId, fixtures: 'synthetic SQLite and native proofs; actual Electron UI and native confirmation', actions: [], osCalls: 0 }
  const save = () => fs.writeFile(path.join(root, '.verification/results-manual-report.json'), JSON.stringify(log, null, 2))
  const trash = new TrashService((method, value) => ({ trashPrepare: () => catalog.prepareTrash(value), trashVerify: () => catalog.verifyTrash(value), trashRecord: () => catalog.recordTrash(value), trashRelease: () => catalog.releaseTrash(value) })[method](),
    async plan => { const answer = await dialog.showMessageBox(trashConfirmationOptions(plan)); log.actions.push({ action: 'confirmation', response: answer.response }); await save(); return answer.response === 1 },
    async () => { log.osCalls++; await save(); throw Error('MANUAL_HARNESS_CANCEL_ONLY') }, () => false)
  ipcMain.handle('duprove:catalog', async (_event, request) => { const result = await catalog.request(request); log.actions.push({ action: request.action }); await save(); return result })
  ipcMain.handle('duprove:trash', async (_event, request) => { const result = await trash.run(request); log.actions.push({ action: 'trash', cancelled: result.cancelled }); await save(); return result })
  ipcMain.handle('duprove:analysis:get', () => ({ ...emptySnapshot(), id: analysisId, revision: 1, status: 'completed' }))
  ipcMain.handle('duprove:drives', () => [])
  ipcMain.handle('duprove:update:get', () => ({ revision: 0, status: 'idle' }))
  ipcMain.handle('duprove:delivery:get', () => ({ revision: 0, configured: false }))
  const window = new BrowserWindow({ width: 1280, height: 800, title: 'Duprove — проверка итерации 2', webPreferences: {
    preload: path.join(root, 'dist-electron/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } })
  window.on('page-title-updated', event => event.preventDefault())
  window.on('close', event => { if (trash.busy) event.preventDefault() })
  await window.loadFile(path.join(root, 'dist/index.html'))
  await save(); console.log('MANUAL_RESULTS_READY')
}).catch(e => { console.error(e); app.exit(1) })
app.on('window-all-closed', () => app.quit())
