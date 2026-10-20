import { createPublicKey, verify } from 'node:crypto'

export const repository = 'frdkss/Duprove'
export const dataSchema = 1
export interface UpdateTarget {
  platform: 'win32' | 'linux'
  arch: 'x64' | 'arm64'
  format: 'nsis' | 'tar.gz'
  minOs: string
  minGlibc?: string
  asset: string
  size: number
  sha512: string
}
export interface UpdateManifest { schema: 1; channel: 'stable'; version: string; dataSchema: number; targets: UpdateTarget[] }
export interface UpdateHost { platform: string; arch: string; format: string; osVersion: string; glibc?: string }
export const stableVersion = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}
const osVersion = (v: unknown): v is string => typeof v === 'string' && /^\d{1,6}(\.\d{1,6}){1,3}$/.test(v)
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// Sign exact payload bytes, not a re-serialized object. The trust root is built into the app.
export function verifyManifest(envelope: Buffer, publicKey: string, expectedVersion: string): UpdateManifest {
  if (envelope.length > 65536 || !stableVersion(expectedVersion)) throw Error('UPDATE_MANIFEST_INVALID')
  const signed: unknown = JSON.parse(envelope.toString('utf8'))
  if (!record(signed) || typeof signed.payload !== 'string' || typeof signed.signature !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.payload) || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) throw Error('UPDATE_MANIFEST_INVALID')
  const key = createPublicKey(publicKey)
  const payload = Buffer.from(signed.payload, 'base64')
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, Buffer.from(signed.signature, 'base64'))) throw Error('UPDATE_SIGNATURE_INVALID')
  const value: unknown = JSON.parse(payload.toString('utf8'))
  if (!record(value) || value.schema !== 1 || value.channel !== 'stable' || value.version !== expectedVersion
    || !Number.isSafeInteger(value.dataSchema) || !Array.isArray(value.targets) || value.targets.length > 16) throw Error('UPDATE_MANIFEST_INVALID')
  const seen = new Set<string>()
  for (const target of value.targets) {
    if (!record(target) || !['win32', 'linux'].includes(String(target.platform)) || !['x64', 'arm64'].includes(String(target.arch))
      || target.format !== (target.platform === 'win32' ? 'nsis' : 'tar.gz') || !osVersion(target.minOs)
      || (target.platform === 'linux' && !osVersion(target.minGlibc))
      || typeof target.asset !== 'string' || target.asset !== `Duprove-${expectedVersion}-${target.platform === 'win32' ? 'win' : 'linux'}-${target.arch}.${target.format === 'nsis' ? 'exe' : 'tar.gz'}`
      || !Number.isSafeInteger(target.size) || Number(target.size) < 1 || Number(target.size) > 1024 ** 3
      || typeof target.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(target.sha512)) throw Error('UPDATE_MANIFEST_INVALID')
    const id = `${target.platform}-${target.arch}`
    if (seen.has(id)) throw Error('UPDATE_MANIFEST_INVALID')
    seen.add(id)
  }
  return value as unknown as UpdateManifest
}
export function selectTarget(manifest: UpdateManifest, host: UpdateHost): UpdateTarget | undefined {
  if (manifest.dataSchema !== dataSchema || !osVersion(host.osVersion)) return undefined
  return manifest.targets.find(t => t.platform === host.platform && t.arch === host.arch && t.format === host.format
    && compareVersions(host.osVersion, t.minOs) >= 0
    && (t.platform !== 'linux' || !!host.glibc && osVersion(host.glibc) && compareVersions(host.glibc, t.minGlibc!) >= 0))
}
export function assetUrl(version: string, asset: string): string {
  return `https://github.com/${repository}/releases/download/v${version}/${asset}`
}
