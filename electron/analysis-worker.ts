import { parentPort, workerData } from 'node:worker_threads'
import { JobService } from './services/job-service'

const service = new JobService(workerData.executable, workerData.directory, workerData.consentFile)
service.on('snapshot', snapshot => parentPort!.postMessage({ snapshot }))
let commands = service.restore().then(() => { parentPort!.postMessage({ ready: true, snapshot: service.snapshot() }) })
parentPort!.on('message', ({ id, method, value }) => {
  commands = commands.then(async () => {
    try {
      let result
      if (method === 'start') result = await service.start(value)
      else if (method === 'command') result = await service.command(value)
      else if (method === 'report') result = await service.report()
      else if (method === 'catalog') {
        if (['running', 'paused', 'stopping'].includes(service.snapshot().status)) throw Error('ANALYSIS_BUSY')
        if (value?.analysisId !== service.snapshot().id) throw Error('CATALOG_UNAVAILABLE')
        result = await service.catalog.request(value)
      }
      else if (method === 'trashPrepare') {
        if (['running', 'paused', 'stopping'].includes(service.snapshot().status)) throw Error('ANALYSIS_BUSY')
        if (value?.analysisId !== service.snapshot().id) throw Error('CATALOG_UNAVAILABLE')
        result = await service.catalog.prepareTrash(value)
      }
      else if (method === 'trashVerify') result = await service.catalog.verifyTrash(value)
      else if (method === 'trashExecute') result = await service.catalog.executeTrash(value)
      else if (method === 'trashRecord') result = await service.catalog.recordTrash(value)
      else if (method === 'trashRelease') result = service.catalog.releaseTrash(value)
      else if (method === 'shutdown') result = await service.shutdown()
      else throw new Error('INVALID_ANALYSIS_METHOD')
      parentPort!.postMessage({ id, result })
    } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'ANALYSIS_FAILED' }) }
  })
})
