import { readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { digest } from './release-manifest.mjs'
import names from './artifact-names.cjs'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const platform = process.platform, arch = process.arch
const extensions = platform === 'win32' ? ['exe'] : platform === 'linux' ? ['tar.gz'] : ['pkg', 'dmg']
const files = await Promise.all(extensions.map(async extension => {
  const name = names.artifactName(version, platform, arch, extension), file = path.join('release', name)
  return { name, size: (await stat(file)).size, sha512: await digest(file) }
}))
const label = files[0].name.slice(`Duprove-${version}-`.length, -extensions[0].length - 1)
const windowsDefender = platform === 'win32' ? await Promise.all(['duprove-analyzer.exe', files[0].name].map(async name => {
  try { return JSON.parse(await readFile(path.join('.verification/defender', name + '.json'), 'utf8')) }
  catch { return { file: name, status: 'unavailable' } }
})) : undefined
const sourceCommit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
await writeFile(`release/BUILD-${label}.json`, JSON.stringify({ version, platform, arch, bits: 64, sourceCommit, files,
  windowsDefender, appleSigning: platform === 'darwin' ? 'unsigned; not notarized' : undefined }, null, 2) + '\n')
await writeFile(`release/SHA512SUMS-${label}`, files.map(file => `${file.sha512}  ${file.name}`).join('\n') + '\n')
console.log(`INSTALLERS_READY ${version}: ${files.map(file => file.name).join(', ')}`)
