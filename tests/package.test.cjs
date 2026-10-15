const { test } = require('node:test')
const assert = require('node:assert/strict')
const { binaryTarget } = require('../scripts/verify-package.cjs')
const { checkWindowsDefender } = require('../scripts/check-windows-defender.cjs')

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
