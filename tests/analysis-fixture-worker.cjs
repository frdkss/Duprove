// A real worker and analyzer; only drive discovery is replaced by synthetic roots.
const { parentPort, workerData } = require('node:worker_threads')
const path = require('node:path')
const { JobService } = require('../.verification/tests/electron/services/job-service.js')
const service = new JobService(workerData.executable, workerData.directory, workerData.consentFile,
  async () => ['a', 'b'].map(name => ({ path: path.join(workerData.directory, '..', name), name, capacity: 10e9, available: 5e9 })))
service.on('snapshot', snapshot => parentPort.postMessage({ snapshot }))
service.restore().then(() => parentPort.postMessage({ ready: true, snapshot: service.snapshot() }))
parentPort.on('message', async ({ id, method, value }) => {
  try {
    const result = method === 'start' ? await service.start(value) : method === 'command' ? await service.command(value)
      : method === 'shutdown' ? await service.shutdown() : await service.report()
    parentPort.postMessage({ id, result })
  } catch (error) { parentPort.postMessage({ id, error: error.message }) }
})
