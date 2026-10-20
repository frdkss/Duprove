import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env')
const action = process.argv[2] ?? 'up'
if (!['up', 'stop', 'check'].includes(action)) throw new Error('Use up, stop or check')
if (!existsSync(envFile)) {
  if (action !== 'up') throw new Error('Run npm run server:dev first')
  writeFileSync(envFile, readFileSync(join(root, '.env.example')), { mode: 0o600 })
}
const settings = parseEnv(readFileSync(envFile, 'utf8'))
const project = settings.DUPROVE_DEV_PROJECT || 'duprove-debug'
if (!/^duprove-debug(?:-[a-z0-9-]+)?$/.test(project)) {
  throw new Error('DUPROVE_DEV_PROJECT must be duprove-debug or duprove-debug-<suffix>')
}
const listen = settings.DUPROVE_LISTEN || '127.0.0.1:8443'
const match = /^127\.0\.0\.1:([0-9]{1,5})$/.exec(listen)
if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) {
  throw new Error('Debug DUPROVE_LISTEN must be 127.0.0.1:<port 1024..65535>')
}
// This command owns only its local debug certificates, never production TLS files.
const tls = join(root, '.verification', 'server-dev', 'tls')
const caFile = join(tls, 'fullchain.pem')
const keyFile = join(tls, 'privkey.pem')
const endpoint = `https://${listen}/v1/reports`
const env = { ...process.env, ...settings, DUPROVE_LISTEN: listen, DUPROVE_TLS_DIR: tls }
const compose = ['compose', '--env-file', envFile, '-p', project, '-f', 'backend/deploy/compose.yaml']

function docker(args, capture = false) {
  return execFileSync('docker', args, { cwd: root, env, windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })?.trim()
}

function save(values) {
  let source = readFileSync(envFile, 'utf8').replace(/\r\n/g, '\n')
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.replaceAll('\\', '/')
    if (/[\r\n']/.test(value)) throw new Error('Unsupported character in debug configuration')
    const line = `${key}='${value}'`
    const pattern = new RegExp(`^${key}=.*$`, 'gm')
    source = pattern.test(source) ? source.replace(pattern, () => line) : `${source.trimEnd()}\n${line}\n`
  }
  writeFileSync(envFile, source, { mode: 0o600 })
}

function containerIP() {
  const id = docker([...compose, 'ps', '-q', 'proxy'], true)
  if (!id) throw new Error('Debug proxy is not running; run npm run server:dev')
  const info = JSON.parse(docker(['inspect', id], true))[0]
  const ip = info.NetworkSettings.Networks[`${project}_edge`]?.IPAddress
  if (isIP(ip ?? '') !== 4) throw new Error('Docker did not return an IPv4 address for the debug proxy')
  return ip
}

async function check(url, certificate) {
  if (url !== endpoint) throw new Error('Debug URL does not match DUPROVE_LISTEN; run npm run server:dev')
  await new Promise((accept, reject) => {
    // GET intentionally exercises TLS/API without saving a synthetic report.
    const request = https.get(url, { ca: readFileSync(certificate), rejectUnauthorized: true, timeout: 5000 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        if (body.length > 4096) response.destroy(new Error('Unexpected debug response'))
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 405 || JSON.parse(body).accepted !== false) {
            throw new Error('Unexpected debug API response')
          }
          accept()
        } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('Debug API timeout')))
    request.on('error', reject)
  })
}

if (action === 'stop') {
  docker([...compose, 'stop'])
} else if (action === 'check') {
  if (containerIP() !== settings.DUPROVE_CONTAINER_IP) throw new Error('Container IP changed; run npm run server:dev')
  await check(settings.DUPROVE_REPORT_URL, resolve(root, settings.DUPROVE_CA_FILE))
  console.log('Debug HTTPS and .env container address verified; no report sent.')
} else {
  mkdirSync(tls, { recursive: true, mode: 0o755 })
  docker([...compose, 'build', 'receiver'])
  let validCertificate = false
  if (existsSync(caFile) && existsSync(keyFile)) {
    try {
      const certificate = new X509Certificate(readFileSync(caFile))
      validCertificate = !!certificate.checkIP('127.0.0.1')
        && Date.parse(certificate.validTo) > Date.now() + 86400000
    } catch { /* Replace only the command's own expired/invalid debug certificate. */ }
  }
  if (!validCertificate) {
    docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '--mount', `type=bind,source=${tls},target=/tls`, '--entrypoint', 'openssl', `${project}-receiver:local`,
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/tls/privkey.pem',
      '-out', '/tls/fullchain.pem', '-days', '30', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], true)
  }
  // Local self-signed key only, readable by nginx UID 101 in the bind mount.
  // Run chmod inside Linux too: Windows chmod does not change Docker's POSIX metadata.
  docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    '--mount', `type=bind,source=${tls},target=/tls`, '--entrypoint', 'chmod', `${project}-receiver:local`,
    '644', '/tls/privkey.pem', '/tls/fullchain.pem'])
  save({ DUPROVE_DEV_PROJECT: project, DUPROVE_LISTEN: listen, DUPROVE_TLS_DIR: tls,
    DUPROVE_CA_FILE: caFile, DUPROVE_REPORT_URL: endpoint })
  docker([...compose, 'up', '-d', '--no-build', ...(validCertificate ? [] : ['--force-recreate']),
    '--wait', '--wait-timeout', '120'])
  docker([...compose, 'exec', '-T', 'proxy', 'nginx', '-t'])
  // Bind-mounted config changes do not recreate the proxy. Reload also resolves
  // the receiver address after Compose replaced its container during an update.
  docker([...compose, 'exec', '-T', 'proxy', 'nginx', '-s', 'reload'])
  const ip = containerIP()
  save({ DUPROVE_CONTAINER_IP: ip })
  await check(endpoint, caFile)
  console.log(`Debug HTTPS: ${endpoint}\nDocker proxy IP: ${ip}\nSaved to ${envFile}`)
}
