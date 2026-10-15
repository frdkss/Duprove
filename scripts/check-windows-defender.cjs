const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function checkWindowsDefender(file, projectDir, run = spawnSync) {
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = run(shell, ['-NoProfile', '-NonInteractive', '-File',
    join(projectDir, 'scripts/check-windows-defender.ps1'), '-Path', file], {
    cwd: projectDir, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000,
  })
  if (result.error || result.status !== 0) {
    throw Error('WINDOWS_DEFENDER_CHECK_FAILED: package blocked; see .verification/defender and docs/windows-defender.md', { cause: result.error })
  }
}

module.exports = { checkWindowsDefender }
