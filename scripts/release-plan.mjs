import { createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function planRelease({ version, ref, sha, tagSha, release }) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw Error('RELEASE_VERSION_INVALID')
  const tag = `v${version}`
  if (ref !== 'refs/heads/main' && ref !== `refs/tags/${tag}`) throw Error('RELEASE_REF_MUST_BE_MAIN_OR_MATCHING_TAG')
  if (release && !release.draft) {
    if (release.prerelease) throw Error('RELEASE_VERSION_ALREADY_PRERELEASE')
    // A push with the same version must not overwrite an installed release.
    if (ref.startsWith('refs/tags/') && tagSha !== sha) throw Error('RELEASE_TAG_COMMIT_MISMATCH')
    return { tag, publish: false }
  }
  if (tagSha && tagSha !== sha) throw Error('RELEASE_TAG_COMMIT_MISMATCH')
  if (release) throw Error('RELEASE_DRAFT_EXISTS: inspect the incomplete draft before retrying')
  return { tag, publish: true }
}

async function main() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  const key = createPublicKey(await readFile('config/update-public-key.pem'))
  if (key.asymmetricKeyType !== 'ed25519') throw Error('RELEASE_PUBLIC_KEY_INVALID')
  const { GITHUB_REPOSITORY: repository, GITHUB_REF: ref, GITHUB_SHA: sha, GH_TOKEN: token, GITHUB_OUTPUT: output } = process.env
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token || !output || !/^[a-f0-9]{40}$/.test(sha || '')) throw Error('RELEASE_ACTION_CONTEXT_REQUIRED')
  // Validate the version/ref before using the tag in a URL or git command.
  const initial = planRelease({ version, ref, sha })
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(initial.tag)}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok && response.status !== 404) throw Error(`RELEASE_LOOKUP_FAILED: HTTP ${response.status}`)
  const release = response.status === 404 ? null : await response.json()
  let tagSha
  try { tagSha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${initial.tag}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) { if (error.status !== 128) throw error }
  const plan = planRelease({ version, ref, sha, tagSha, release })
  await appendFile(output, `tag=${plan.tag}\npublish=${plan.publish}\n`)
  console.log(plan.publish ? `Prepare ${plan.tag} from ${sha}` : `${plan.tag} is already published; increase package.json version for a new release.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
