const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')

function windowsPowerShellEnvironment(environment = process.env) {
  // pwsh -> npm/Node -> Windows PowerShell otherwise inherits PS7-only modules.
  // Let powershell.exe rebuild its own module path; do not change the parent.
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'))
}

function runDefender(args, projectDir, run = spawnSync) {
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  return run(shell, ['-NoProfile', '-NonInteractive', '-File',
    join(projectDir, 'scripts/check-windows-defender.ps1'), ...args], {
    cwd: projectDir, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000,
    env: windowsPowerShellEnvironment(),
  })
}

function checkWindowsDefender(file, projectDir, run = spawnSync, { reportOnly = false } = {}) {
  const result = runDefender(['-Path', file], projectDir, run)
  if (result.error || result.status !== 0) {
    if (reportOnly) {
      console.warn(`WINDOWS_DEFENDER_REPORT_ONLY: scan not confirmed clean for ${file}; exit=${result.status}; error=${result.error?.message ?? 'none'}. See .verification/defender.`)
      return false
    }
    throw Error('WINDOWS_DEFENDER_CHECK_FAILED: package blocked; see .verification/defender and docs/windows-defender.md', { cause: result.error })
  }
  return true
}

module.exports = { checkWindowsDefender, windowsPowerShellEnvironment }

if (require.main === module) {
  if (process.platform !== 'win32') throw Error('WINDOWS_DEFENDER_REQUIRES_WINDOWS')
  const result = runDefender(process.argv.slice(2), resolve(__dirname, '..'))
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status === 0 && !result.error ? 0 : 1
}
