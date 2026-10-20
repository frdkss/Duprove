import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Deliberately refuses to overwrite either half of an existing trust root.
const directory = path.resolve('.tools/release-signing')
mkdirSync(directory, { recursive: true, mode: 0o700 })
if (process.platform === 'win32') {
  const identity = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true })
  if (identity.status !== 0) throw Error('SIGNING_KEY_ACL_FAILED')
  const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity.stdout.trim()}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' })
  if (acl.status !== 0) throw Error('SIGNING_KEY_ACL_FAILED')
}
const pair = generateKeyPairSync('ed25519')
mkdirSync('config', { recursive: true })
writeFileSync(path.join(directory, 'private.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
writeFileSync('config/update-public-key.pem', pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 })
console.log('Created private key in .tools/release-signing/private.pem and public trust root in config/update-public-key.pem. Private key contents were not printed.')
