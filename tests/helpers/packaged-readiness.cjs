const { setTimeout: delay } = require('node:timers/promises')

// The inspector opens during Electron bootstrap, before the application's CJS entry exists.
async function waitForMain(evaluate, { timeoutMs = 10000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const response = await evaluate("typeof process.mainModule?.require === 'function'")
    if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response))
    if (response.result?.result?.value === true) return
    if (Date.now() >= deadline) break
    await delay(pollMs)
  } while (Date.now() <= deadline)
  throw Error('PACKAGED_MAIN_NOT_READY')
}

module.exports = { waitForMain }
