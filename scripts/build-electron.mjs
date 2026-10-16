import { build } from 'esbuild'
import { createPublicKey } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
const publicKey = existsSync('config/update-public-key.pem') ? readFileSync('config/update-public-key.pem', 'utf8') : ''
if (publicKey && createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw Error('UPDATE_KEY_MUST_BE_ED25519')
await build({entryPoints:['electron/main.ts','electron/preload.ts','electron/analysis-worker.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',outdir:'dist-electron',external:['electron'],define:{__DUPROVE_UPDATE_KEY__:JSON.stringify(publicKey)}})
