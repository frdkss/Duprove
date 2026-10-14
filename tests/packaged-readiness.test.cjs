const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { waitForMain } = require('./helpers/packaged-readiness.cjs')

test('inspector may connect before Electron creates its application main module', async () => {
  const context = { process: {} }
  let probes = 0
  await waitForMain(async expression => {
    // Reproduce the startup order from the macOS Intel and Linux CI failures.
    if (++probes === 3) context.process.mainModule = { require() { throw Error('Must not load Electron while probing') } }
    return { result: { result: { value: vm.runInNewContext(expression, context) } } }
  }, { pollMs: 1 })
  assert.equal(probes, 3)
})

test('main readiness has a bounded timeout', async () => {
  await assert.rejects(waitForMain(async () => ({ result: { result: { value: false } } }),
    { timeoutMs: 0, pollMs: 1 }), /PACKAGED_MAIN_NOT_READY/)
})

test('main readiness does not hide inspector or evaluation errors', async () => {
  for (const response of [{ error: { message: 'Inspector failure' } },
    { result: { exceptionDetails: { text: 'Evaluation failure' } } }]) {
    await assert.rejects(waitForMain(async () => response), /failure/)
  }
})
