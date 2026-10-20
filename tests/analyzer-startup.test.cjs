const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { listDrives } = require('../.verification/tests/electron/services/analyzer-service.js')

test('drive discovery distinguishes a missing executable from an empty drive list', async () => {
  await assert.rejects(listDrives(path.join(__dirname, 'nonexistent-analyzer.exe')), /ANALYZER_NOT_FOUND/)
  assert.deepEqual(await listDrives('analyzer', async () => ({ stdout: '[]' })), [])
})

test('drive discovery keeps launch failures separate from invalid responses', async () => {
  for (const [failure, expected] of [
    [{ code: 'EACCES' }, 'ANALYZER_ACCESS_DENIED'],
    [{ code: 'EPERM' }, 'ANALYZER_ACCESS_DENIED'],
    [{ killed: true, code: null }, 'ANALYZER_TIMEOUT'],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'ANALYZER_INVALID_DRIVES'],
    [{ code: 'UNKNOWN', errno: -4094 }, 'ANALYZER_LAUNCH_FAILED'],
    [{ code: 1 }, 'ANALYZER_LAUNCH_FAILED'],
  ]) {
    await assert.rejects(listDrives('analyzer', async () => { throw failure }), error => error.message === expected && error.cause === failure)
  }
  for (const stdout of ['not-json', '{}', '[{"path":"C:"}]']) {
    await assert.rejects(listDrives('analyzer', async () => ({ stdout })), /ANALYZER_INVALID_DRIVES/)
  }
})

test('drive discovery accepts valid volumes and omits extra native properties', async () => {
  const drive = { path: 'C:\\', name: 'C:\\', capacity: 1000, available: 500 }
  assert.deepEqual(await listDrives('analyzer', async () => ({ stdout: JSON.stringify([{ ...drive, extra: true }]) })), [drive])
})
