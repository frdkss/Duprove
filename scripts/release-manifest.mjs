import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import names from './artifact-names.cjs'

export async function digest(file) {
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
export async function makeManifest(directory, version, privatePem, publicPem) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw Error('RELEASE_VERSION_INVALID')
  const key = createPrivateKey(privatePem)
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).equals(createPublicKey(publicPem))) throw Error('RELEASE_SIGNING_KEY_MISMATCH')
  // Conservative, explicit baseline matching the release runners. Changing it requires platform validation.
  const targets = [
    { platform: 'win32', arch: 'x64', format: 'nsis', minOs: '10.0.19045', asset: names.updateAssetName(version, 'win32', 'x64') },
    { platform: 'linux', arch: 'x64', format: 'tar.gz', minOs: '5.15.0', minGlibc: '2.35', asset: names.updateAssetName(version, 'linux', 'x64') },
  ]
  for (const target of targets) {
    const file = path.join(directory, target.asset)
    target.size = (await stat(file)).size
    if (!target.size || target.size > 1024 ** 3) throw Error('RELEASE_SIZE_INVALID')
    target.sha512 = await digest(file)
  }
  const payload = Buffer.from(JSON.stringify({ schema: 1, channel: 'stable', version, dataSchema: 1, targets }))
  return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }
}
async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  if ((process.env.DUPROVE_RELEASE_TAG || process.env.GITHUB_REF_NAME) !== `v${pkg.version}`) throw Error('RELEASE_TAG_MUST_MATCH_PACKAGE_VERSION')
  const privatePem = process.env.DUPROVE_UPDATE_PRIVATE_KEY
  if (!privatePem) throw Error('RELEASE_SIGNING_KEY_REQUIRED')
  const directory = process.argv[2] || 'release'
  const envelope = await makeManifest(directory, pkg.version, privatePem, await readFile('config/update-public-key.pem', 'utf8'))
  await writeFile(path.join(directory, 'stable.json'), JSON.stringify(envelope) + '\n')
  const installers = (await readdir(directory)).filter(name => /^Duprove-.*\.(exe|tar\.gz|pkg|dmg)$/.test(name)).sort()
  const checksums = await Promise.all(installers.map(async name => `${await digest(path.join(directory, name))}  ${name}`))
  await writeFile(path.join(directory, 'SHA512SUMS'), checksums.join('\n') + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
