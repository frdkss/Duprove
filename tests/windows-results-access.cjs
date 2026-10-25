const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { fileGuard } = require('../.verification/tests/electron/services/file-guard.js')
const [mode, file] = process.argv.slice(2)
const timeout = setTimeout(() => { console.error('WINDOWS_ACCESS_TIMEOUT'); process.exit(1) }, 30000)
async function main() {
  if (mode === 'readable') {
    await fileGuard(file); assert.equal(await fs.readFile(file, 'utf8'), 'disposable-access-fixture')
  } else if (mode === 'denied') {
    await assert.rejects(fs.readFile(file), error => ['EACCES','EPERM'].includes(error.code))
    // Metadata access is distinct from read-data permission on Windows.
    let metadataReadable = false
    try { await fileGuard(file); metadataReadable = true } catch { /* access denied */ }
    console.log('WINDOWS_READ_DENIAL_OK ' + JSON.stringify({ metadataReadable, readDenied: true }))
  } else if (mode === 'network') {
    assert.ok(file.startsWith('\\\\127.0.0.1\\Duprove-nonexistent-'))
    await assert.rejects(fileGuard(file))
    console.log('WINDOWS_MISSING_UNC_OK')
  } else throw Error('INVALID_ACCESS_TEST_MODE')
  clearTimeout(timeout)
}
main().catch(error => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
