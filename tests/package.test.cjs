const { test } = require('node:test')
const assert = require('node:assert/strict')
const { binaryTarget } = require('../scripts/verify-package.cjs')
const { checkWindowsDefender, windowsPowerShellEnvironment } = require('../scripts/check-windows-defender.cjs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

test('Windows PowerShell receives its own module path without changing the parent environment', () => {
  const source = { PATH: 'keep', PSModulePath: 'PS7/modules', psmodulepath: 'other', CUSTOM: 'keep too' }
  assert.deepEqual(windowsPowerShellEnvironment(source), { PATH: 'keep', CUSTOM: 'keep too' })
  assert.equal(source.PSModulePath, 'PS7/modules')
})

test('real Windows PowerShell hashes files with a missing inherited module path', { skip: process.platform !== 'win32' }, () => {
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; (Get-FileHash -LiteralPath $env:DUPROVE_TEST_HASH_FILE -Algorithm SHA256).Hash'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: windowsPowerShellEnvironment({ ...process.env, PSModulePath: 'Z:\\nonexistent-PS7-modules', DUPROVE_TEST_HASH_FILE: __filename }),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim().toLowerCase(), createHash('sha256').update(readFileSync(__filename)).digest('hex'))
})

test('Windows packaging fails closed on Defender detection, unavailability, or timeout', () => {
  const file = 'C:\\build with spaces\\analyzer.exe'
  for (const result of [{ status: 1 }, { status: 2 }, { status: -2142236669 },
    { status: null, signal: 'SIGTERM' }, { status: null, error: Error('ENOENT') }]) {
    assert.throws(() => checkWindowsDefender(file, 'C:\\project', () => result), /WINDOWS_DEFENDER_CHECK_FAILED/)
  }
  checkWindowsDefender(file, 'C:\\project', (command, args, options) => {
    assert.equal(args.at(-1), file)
    assert.equal(options.shell, undefined)
    assert.equal(options.windowsHide, true)
    assert.ok(options.timeout > 0)
    assert.ok(Object.keys(options.env).every(name => name.toUpperCase() !== 'PSMODULEPATH'))
    return { status: 0 }
  })
})
test('packaging distinguishes analyzer OS and CPU and rejects unknown executables', () => {
  for (const [machine, arch] of [[62, 'x64'], [183, 'arm64']]) {
    const elf = Buffer.alloc(64)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf)
    elf.writeUInt16LE(machine, 18)
    assert.deepEqual(binaryTarget(elf), { platform: 'linux', arch })
  }
  for (const [cpu, arch] of [[0x01000007, 'x64'], [0x0100000c, 'arm64']]) {
    const macho = Buffer.alloc(64)
    macho.writeUInt32LE(0xfeedfacf)
    macho.writeUInt32LE(cpu, 4)
    assert.deepEqual(binaryTarget(macho), { platform: 'darwin', arch })
  }
  const pe = Buffer.alloc(128)
  pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68)
  assert.deepEqual(binaryTarget(pe), { platform: 'win32', arch: 'x64' })
  assert.throws(() => binaryTarget(Buffer.from('#!/bin/sh')), /ANALYZER_BINARY_INVALID/)
})
