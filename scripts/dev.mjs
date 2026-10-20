import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electron from 'electron'
await import('./build-icons.mjs')
await import('./build-electron.mjs')
const server = await createServer(); await server.listen()
const env = {...process.env,DUPROVE_DEV_URL:'http://127.0.0.1:5173'}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron,['.'],{stdio:'inherit',env,windowsHide:false})
child.on('error',async ()=>{await server.close();console.error('ELECTRON_START_FAILED');process.exitCode=1})
child.on('exit',async code=>{await server.close();process.exit(code??0)})
