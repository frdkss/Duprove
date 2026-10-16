const { readFileSync } = require('node:fs')
const path = require('node:path')

function binaryTarget(bytes) {
  if (bytes.length < 64) throw Error('ANALYZER_BINARY_INVALID')
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1) {
    return { platform: 'linux', arch: { 62: 'x64', 183: 'arm64' }[bytes.readUInt16LE(18)] }
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { platform: 'darwin', arch: { 0x01000007: 'x64', 0x0100000c: 'arm64' }[bytes.readUInt32LE(4)] }
  }
  if (bytes.toString('ascii', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(60)
    if (offset + 6 <= bytes.length && bytes.readUInt32LE(offset) === 0x4550) {
      return { platform: 'win32', arch: { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(offset + 4)] }
    }
  }
  throw Error('ANALYZER_BINARY_INVALID')
}
module.exports = async context => {
  const platform = context.electronPlatformName
  const arch = require('builder-util').Arch[context.arch]
  const file = path.join(context.packager.projectDir, 'build/native/bin', platform === 'win32' ? 'duprove-analyzer.exe' : 'duprove-analyzer')
  const native = binaryTarget(readFileSync(file))
  if (native.platform !== platform || native.arch !== arch) throw Error('ANALYZER_TARGET_MISMATCH: build the analyzer on the target OS and architecture before packaging')
  if (platform === 'win32') require('./check-windows-defender.cjs').checkWindowsDefender(file, context.packager.projectDir)
}
module.exports.binaryTarget = binaryTarget
