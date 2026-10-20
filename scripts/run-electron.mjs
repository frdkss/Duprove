import { spawn } from 'node:child_process'
import electron from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false })
child.on('error', () => { console.error('ELECTRON_START_FAILED'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
