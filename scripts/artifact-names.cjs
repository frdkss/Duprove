const platforms = { win32: 'windows', linux: 'linux', darwin: 'macos' }
const architectures = { x64: 'x86_64', arm64: 'arm64' }
function artifactTemplate(platform, arch) {
  if (!platforms[platform] || !architectures[arch]) throw Error('INSTALLER_TARGET_UNSUPPORTED')
  return `Duprove-\${version}-${platforms[platform]}-64bit-${architectures[arch]}.\${ext}`
}
function artifactName(version, platform, arch, extension) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['exe', 'tar.gz', 'pkg', 'dmg'].includes(extension)) throw Error('INSTALLER_NAME_INVALID')
  return artifactTemplate(platform, arch).replace('${version}', version).replace('${ext}', extension)
}
function updateAssetName(version, platform, arch) {
  if (!['win32', 'linux'].includes(platform)) throw Error('UPDATE_TARGET_UNSUPPORTED')
  const extension = platform === 'win32' ? 'exe' : 'tar.gz'
  return Number(version.split('.')[0]) >= 2 ? artifactName(version, platform, arch, extension)
    : `Duprove-${version}-${platform === 'win32' ? 'win' : 'linux'}-${arch}.${extension}`
}
module.exports = { artifactTemplate, artifactName, updateAssetName }
